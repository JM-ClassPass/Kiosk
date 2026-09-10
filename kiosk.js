import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, signOut, setPersistence, browserSessionPersistence } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getDatabase, ref, onValue, get, set, push, remove, serverTimestamp, runTransaction } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";
import { APP_CONFIG, PASS_TYPES, applyBranding } from "./config.js";

// 1. Initialize Firebase App, Auth, and Database
const app = initializeApp(APP_CONFIG.firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

// Apply branding immediately — doesn't depend on Firebase auth succeeding,
// so it shouldn't wait on it. If sign-in is slow or fails, the page should
// still show the right school name/logo rather than sitting on whatever
// fallback text is in the raw HTML.
applyBranding("Kiosk");

// 2. Authenticate the Kiosk
// IMPORTANT: use tab-scoped (session) persistence, not the default
// browserLocalPersistence. The default persistence syncs the "current
// signed-in user" across every tab of the same origin — which means a
// teacher signing into teacher.html/roster.html in another tab of the
// SAME browser would silently overwrite this kiosk's session (and vice
// versa) the moment either tab regains focus. That cross-tab stomping is
// what caused the intermittent permission-denied errors. Session
// persistence keeps this kiosk's identity confined to this one tab.
setPersistence(auth, browserSessionPersistence)
  .then(() => signInWithEmailAndPassword(auth, APP_CONFIG.kioskAuth.email, APP_CONFIG.kioskAuth.password))
  .then(() => {
    console.log(`Kiosk connected securely for ${APP_CONFIG.department}`);
    
    // ==========================================
    // 1. KIOSK CONFIGURATION
    // Room name comes from APP_CONFIG.department (set per-room in config.js's
    // ROOMS registry) — no separate room number to keep in sync here anymore.
    // ==========================================
    const KIOSK_CONFIG = {
      kioskName: "STUDENT KIOSK",
    };

    // Apply Configuration to the UI
    document.getElementById('kiosk-room').innerHTML = `${KIOSK_CONFIG.kioskName} &bull; ${APP_CONFIG.department}`;

    // ==========================================
    // 2. State Variables
    // ==========================================
    let currentMode = APP_CONFIG.enablePhoneStorage ? 'phone' : APP_CONFIG.enabledPassTypes[0];
    let selectedPocket = null;
    // Declared early, deliberately - a Firebase listener set up later in this
    // file (subscribePocketOccupancy) can fire almost immediately on
    // subscription and reach refocusScannerCatcher() before the script has
    // finished its normal top-to-bottom execution. Since refocusTimer is a
    // `let`, it exists but stays locked (a "temporal dead zone") until its
    // own declaration line actually runs - so if it were declared further
    // down near refocusScannerCatcher itself, that early listener callback
    // could reach it before it's initialized and throw a ReferenceError,
    // which is exactly what broke the kiosk's connection.
    let refocusTimer = null;
    let occupiedPockets = [];
    let unrecognizedAttempts = {};

    // 3. UI Element References
    const clockEl = document.getElementById('kiosk-clock');
    const tabContainer = document.getElementById('tab-container');
    const pocketContainer = document.getElementById('phone-pocket-container');
    const pocketGrid = document.getElementById('pocket-grid');

    // Drive the pocket grid's column count from config, so rows/cols can be
    // changed in one place (APP_CONFIG.pocketLayout) without touching layout CSS.
    pocketGrid.style.gridTemplateColumns = `repeat(${APP_CONFIG.pocketLayout.cols}, minmax(0, 1fr))`;

    const selectedPocketNumSpan = document.getElementById('selected-pocket-num');
    const badge = document.getElementById('screen-badge');
    const title = document.getElementById('screen-title');
    const subtitle = document.getElementById('screen-subtitle');

    const idInput = document.getElementById('kiosk-id-input');
    const submitIdBtn = document.getElementById('btn-submit-id');
    const scannerCatcher = document.getElementById('scanner-catcher');
    const numberPad = document.getElementById('number-pad');

    const guestModal = document.getElementById('guest-request-modal');
    const guestIdDisplay = document.getElementById('guest-id-display');
    const guestNameInput = document.getElementById('guest-name-input');
    const btnCancelGuest = document.getElementById('btn-cancel-guest');
    const btnSubmitGuest = document.getElementById('btn-submit-guest');

    const overlay = document.getElementById('fullscreen-notice');
    const overlayIcon = document.getElementById('fullscreen-notice-icon');
    const overlayTitle = document.getElementById('fullscreen-notice-title');
    const overlaySubtitle = document.getElementById('fullscreen-notice-subtitle');

    // 4. Live Clock
    setInterval(() => {
      clockEl.textContent = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    }, 1000);

    // 5. Tab UI Switching Logic
    // The tab LIST itself is built from config now (phone, if enabled, plus
    // every entry in enabledPassTypes) instead of three fixed HTML buttons —
    // this is what lets M.O.E. run with no phone tab and a third pass type
    // without touching this file or index.html at all.
    const tabList = [
      ...(APP_CONFIG.enablePhoneStorage ? ['phone'] : []),
      ...APP_CONFIG.enabledPassTypes
    ];

    const tabConfigs = {
      phone: { icon: '📱', label: 'Phone Storage', badge: 'Phone Storage Mode Active', title: 'Phone Storage', subtitle: 'Scan/Enter your student ID to check your mobile device in/out of a pocket.' }
    };
    APP_CONFIG.enabledPassTypes.forEach(pt => {
      const meta = PASS_TYPES[pt];
      tabConfigs[pt] = {
        icon: meta.icon,
        label: meta.label,
        badge: `${meta.label} Mode Active`,
        title: meta.label,
        subtitle: `Scan/Enter ID to sign out/in with a ${meta.label.toLowerCase()}.`
      };
    });

    // Build the tab buttons themselves, reusing the exact same classes the
    // old static buttons used, so the look is unchanged even though the
    // markup is now generated.
    tabContainer.style.gridTemplateColumns = `repeat(${tabList.length}, minmax(0, 1fr))`;
    tabContainer.innerHTML = tabList.map(mode => {
      const cfg = tabConfigs[mode];
      const activeClasses = mode === currentMode
        ? 'bg-[#0B4F2C] text-white shadow-md'
        : 'text-slate-600 hover:text-slate-900 hover:bg-white/60';
      return `<button class="kiosk-tab py-3.5 rounded-xl font-extrabold text-sm flex items-center justify-center gap-2 transition ${activeClasses}" data-action="${mode}">
        <span class="text-base">${cfg.icon}</span> ${cfg.label}
      </button>`;
    }).join('');
    const tabs = tabContainer.querySelectorAll('.kiosk-tab');

    // Teacher-controlled on/off switches for kiosk self-service checkouts,
    // one per pass type. Default to true (enabled) when the node doesn't
    // exist yet, so existing classrooms aren't suddenly locked out the
    // moment this ships. This only gates NEW kiosk-initiated requests — it
    // never touches active_passes, so anything already checked out stays
    // exactly as-is regardless of the toggle. Phone storage is never gated
    // by this at all.
    let kioskEnabledState = {}; // { bathroom: true, hall: true, ... }
    APP_CONFIG.enabledPassTypes.forEach(pt => { kioskEnabledState[pt] = true; });

    // Separate from kioskEnabledState above: this one controls whether a
    // phone must be checked in at all before a student can get ANY pass.
    // Defaults to true (required), matching the original behavior. Teacher
    // can flip it off from the dashboard to let students get passes with
    // no phone checked in — useful for students who don't have a phone,
    // or a day the phone system itself is being worked around.
    let requirePhoneCheckin = true;

    function isModeKioskEnabled(mode) {
      if (mode === 'phone') return true;
      return kioskEnabledState[mode] !== false;
    }

    // Re-renders whichever tab is currently selected — used both on tab
    // click and whenever the teacher flips a toggle live, so a student
    // standing at the kiosk sees the disabled message appear immediately
    // rather than only after their next tap.
    function renderCurrentModeScreen() {
      const disabled = !isModeKioskEnabled(currentMode);
      const cfg = tabConfigs[currentMode];

      if (disabled) {
        badge.textContent = `${cfg.title} — New Checkouts Disabled`;
        title.textContent = cfg.title;
        subtitle.textContent = `Kiosk-issued ${cfg.label}es are disabled for new checkouts by the teacher. If you're already out, scan your ID to check back in.`;
        pocketContainer.classList.add('hidden');
        idInput.placeholder = 'Scan or Type ID...';
      } else {
        badge.textContent = cfg.badge;
        title.textContent = cfg.title;
        subtitle.textContent = cfg.subtitle;
        idInput.placeholder = 'Scan or Type ID...';
        if (currentMode === 'phone') {
          pocketContainer.classList.remove('hidden');
        } else {
          pocketContainer.classList.add('hidden');
        }
      }
    }

    // Dims (but doesn't remove) the tab buttons for any mode the teacher has
    // disabled, so it's visually clear before a student even taps it.
    function updateTabDimming() {
      tabs.forEach(t => {
        const mode = t.dataset.action;
        t.classList.toggle('opacity-40', !isModeKioskEnabled(mode));
      });
    }

    onValue(ref(db, 'kiosk_settings'), (snap) => {
      const data = snap.val() || {};
      APP_CONFIG.enabledPassTypes.forEach(pt => {
        kioskEnabledState[pt] = (data[pt] && data[pt].enabled) !== false;
      });
      requirePhoneCheckin = data.requirePhoneCheckin !== false;
      updateTabDimming();
      renderCurrentModeScreen();
    });

    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        tabs.forEach(t => {
          t.className = "kiosk-tab py-3.5 rounded-xl font-extrabold text-sm flex items-center justify-center gap-2 transition text-slate-600 hover:text-slate-900 hover:bg-white/60";
        });
        
        tab.className = "kiosk-tab py-3.5 rounded-xl font-extrabold text-sm flex items-center justify-center gap-2 transition bg-[#0B4F2C] text-white shadow-md";
        currentMode = tab.dataset.action;
        updateTabDimming();

        if (currentMode !== 'phone') {
          selectedPocket = null;
        }
        if (isModeKioskEnabled(currentMode)) {
          if (currentMode === 'phone') autoSelectLowestPocket();
        }
        renderCurrentModeScreen();
        refocusScannerCatcher();
      });
    });

    // 6. Build Pocket Grid & Listen for Occupancy
    function buildPocketGrid() {
      pocketGrid.innerHTML = '';
      for (let i = 1; i <= APP_CONFIG.pocketsAvailable; i++) {
        const btn = document.createElement('button');
        const pStr = i.toString().padStart(2, '0');
        const isOccupied = occupiedPockets.includes(pStr);
        
        btn.textContent = i;
        btn.id = `pocket-btn-${i}`;
        
        if (isOccupied) {
          // 🚫 OCCUPIED: Gray it out and completely disable clicking
          btn.className = 'bg-slate-200 border-slate-300 text-slate-400 font-bold py-2 rounded-lg cursor-not-allowed opacity-60 text-xs';
          btn.disabled = true;
        } else {
          // ✅ AVAILABLE: Make it clickable and style normally
          btn.className = 'bg-white border border-slate-300 text-slate-700 font-bold py-2 rounded-lg hover:bg-slate-100 transition shadow-sm text-xs';
          btn.addEventListener('click', () => {
            setPocketActive(i);
          });
        }
        pocketGrid.appendChild(btn);
      }
    }

    function setPocketActive(num) {
      selectedPocket = num.toString().padStart(2, '0');
      selectedPocketNumSpan.textContent = num;
      
      // Update visual state for all buttons without recreating them
      for (let i = 1; i <= APP_CONFIG.pocketsAvailable; i++) {
        const pBtn = document.getElementById(`pocket-btn-${i}`);
        const pStr = i.toString().padStart(2, '0');
        
        if (occupiedPockets.includes(pStr)) {
          pBtn.className = 'bg-slate-200 border-slate-300 text-slate-400 font-bold py-2 rounded-lg cursor-not-allowed opacity-60 text-xs';
          pBtn.disabled = true;
        } else {
          pBtn.className = 'bg-white border border-slate-300 text-slate-700 font-bold py-2 rounded-lg hover:bg-slate-100 transition shadow-sm text-xs';
          pBtn.disabled = false;
        }
      }
      
      // Highlight the currently selected one in Dark Forest Green
      const activeBtn = document.getElementById(`pocket-btn-${num}`);
      if (activeBtn) {
        activeBtn.className = 'bg-[#0B4F2C] text-white border-[#0B4F2C] font-bold py-2 rounded-lg transform scale-105 shadow-md transition text-xs';
      }
      refocusScannerCatcher();
    }

    function autoSelectLowestPocket() {
      for (let i = 1; i <= APP_CONFIG.pocketsAvailable; i++) {
        if (!occupiedPockets.includes(i.toString().padStart(2, '0'))) {
          setPocketActive(i);
          return;
        }
      }
      // Failsafe if all 35 are full
      selectedPocket = null; 
      selectedPocketNumSpan.textContent = "FULL";
    }

    // ==========================================
    // Self-Healing: recover from a stale auth/connection
    // ==========================================
    // A kiosk left open all day can have its anonymous auth token go stale
    // (background tab throttling, a brief network drop, etc.). Once that
    // happens every read/write starts failing with PERMISSION_DENIED and
    // nothing fixes itself — the SDK doesn't automatically recover a broken
    // connection's auth context. A full reload re-authenticates cleanly, so
    // that's the most reliable fix for a device nobody is actively watching.
    // Guarded so a genuinely broken rules/config issue shows an error
    // instead of reload-looping forever.
    function attemptRecovery(reason) {
      const lastReload = Number(sessionStorage.getItem('kiosk_last_recovery') || 0);
      const now = Date.now();

      if (now - lastReload < 30000) {
        // We already tried this recently and it's still failing — this is
        // not a stale-token blip, something is actually wrong. Don't loop.
        console.error(`Recovery already attempted recently, not reloading again. Reason: ${reason}`);
        showOverlay('SYSTEM ERROR', 'Persistent connection issue — please tell the teacher.', 'error');
        return;
      }

      console.warn(`Recovering from: ${reason}. Reloading in 1.5s...`);
      sessionStorage.setItem('kiosk_last_recovery', String(now));
      showOverlay('RECONNECTING', 'Refreshing the kiosk, one moment...', 'error');
      // Sign out explicitly before reloading so the next load performs a
      // fresh, fully server-validated sign-in rather than assuming
      // whatever's cached is still good.
      signOut(auth).finally(() => {
        setTimeout(() => location.reload(), 1500);
      });
    }

    // Listen to Firebase for live occupied pockets. Wrapped in a function so
    // it can be re-attached on a retry without duplicating this logic.
    let pocketListenerRetried = false;
    function subscribePocketOccupancy() {
      onValue(ref(db, 'active_phones_in_class'), (snapshot) => {
        pocketListenerRetried = false; // a successful read resets the retry budget
        occupiedPockets = [];
        if (snapshot.exists()) {
          const data = snapshot.val();
          Object.values(data).forEach(student => {
            if (student.pocket) {
              // Force it into a padded string (e.g. "05") to guarantee exact matching
              occupiedPockets.push(student.pocket.toString().padStart(2, '0'));
            }
          });
        }
        if (currentMode === 'phone') {
          buildPocketGrid();
          autoSelectLowestPocket();
        }
      }, (err) => {
        console.error("Pocket occupancy listener failed:", err.code || err.name, err.message);
        if (err.code === 'PERMISSION_DENIED' && !pocketListenerRetried) {
          // Most likely a startup race: the sign-in resolved, but the
          // database connection hadn't finished attaching that auth token
          // yet when this listener was first attached. One short-delayed
          // re-attach almost always clears it without needing a reload.
          pocketListenerRetried = true;
          console.warn("Retrying pocket listener in 1s...");
          setTimeout(subscribePocketOccupancy, 1000);
        } else if (err.code === 'PERMISSION_DENIED') {
          // Already retried once and it's still denied — this is no longer
          // a startup timing issue, fall back to the full recovery reload.
          attemptRecovery('pocket listener permission-denied (after retry)');
        }
      });
    }
    subscribePocketOccupancy();

    // Initial load
    buildPocketGrid();
    renderCurrentModeScreen();
    updateTabDimming();
    refocusScannerCatcher();

    // 7. Core Database Operations
    submitIdBtn.addEventListener('click', () => handleIdSubmit());
    // Note: no keypress listener on idInput itself - it's disabled, which
    // means it can never receive focus or keyboard events at all. Enter-key
    // handling lives on scanner-catcher below instead, since that's the
    // only element that ever actually has focus.

    // Clears both the visible display AND the scanner-catching input
    // together. Scanners don't clear a field before typing into it - they
    // just type - so if scanner-catcher were left holding old text, the
    // next scan's characters would append onto stale leftovers instead of
    // starting clean.
    function clearIdField() {
      idInput.value = '';
      scannerCatcher.value = '';
    }

    // Re-establishes focus on scanner-catcher so a barcode scan keeps
    // working after any UI interaction. A fixed delay wasn't enough on its
    // own: with several different places each scheduling their own
    // independent delayed refocus (tab switches, submissions, etc.), a
    // PREVIOUS interaction's still-pending timer could fire while a
    // student was mid-way through a fresh, fast sequence elsewhere -
    // landing close enough to a live tap that iOS still allowed the
    // keyboard through. This is debounced instead: every call cancels
    // whatever refocus was previously scheduled and starts a fresh wait,
    // so as long as activity keeps happening, nothing ever actually fires.
    // The real focus only happens once things have genuinely gone quiet
    // for a moment - never while someone's still actively typing.
    // (refocusTimer itself is declared near the top of this script, not
    // here - see the comment there for why.)
    function refocusScannerCatcher() {
      if (document.activeElement && document.activeElement.blur) {
        document.activeElement.blur();
      }
      if (refocusTimer) clearTimeout(refocusTimer);
      refocusTimer = setTimeout(() => {
        scannerCatcher.focus();
        refocusTimer = null;
      }, 700);
    }

    // A barcode scanner emulates a real keyboard - it types characters into
    // whatever element is focused, then sends Enter. Since kiosk-id-input
    // is disabled (to guarantee the on-screen mobile keyboard can never
    // cover most of the screen when a student taps it), a scanner's
    // simulated keystrokes would be silently blocked there too - a
    // disabled field blocks typed input from ANY source, not just touch.
    // scanner-catcher is a separate, invisible, non-disabled input that
    // stays focused instead; its value mirrors live into the visible
    // display below.
    scannerCatcher.addEventListener('input', () => {
      idInput.value = scannerCatcher.value;
    });
    scannerCatcher.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') handleIdSubmit();
    });

    // On-screen number pad - lets a student build up an ID by touch without
    // ever focusing a real text input, so no native keyboard has a reason
    // to appear. Writes directly to the same idInput.value that
    // handleIdSubmit() already reads from, and keeps scanner-catcher in
    // sync so a half-typed-by-touch ID doesn't get silently overwritten by
    // a stale scanner value the next time someone scans.
    numberPad.addEventListener('click', (e) => {
      const btn = e.target.closest('.keypad-btn');
      if (!btn) return;
      const key = btn.dataset.key;

      if (key === 'clear') {
        clearIdField();
      } else if (key === 'backspace') {
        idInput.value = idInput.value.slice(0, -1);
      } else {
        idInput.value += key;
      }
      scannerCatcher.value = idInput.value;
      // Safe to call here now that refocusScannerCatcher is debounced -
      // every tap just pushes the pending timer further out, so it can
      // never fire mid-sequence. This also cancels any leftover pending
      // refocus from an EARLIER interaction (like page load or a tab
      // switch) that hadn't fired yet when fast typing started.
      refocusScannerCatcher();
    });

    async function handleIdSubmit(isRetry = false) {
      const rawId = idInput.value.trim();
      if (!rawId) return;
      const studentId = rawId.replace(/[^a-zA-Z0-9]/g, '');

      try {
        const rosterRef = ref(db, `classroom_roster/${studentId}`);
        const snapshot = await get(rosterRef);

        if (snapshot.exists()) {
          const studentData = snapshot.val();
          unrecognizedAttempts[studentId] = 0;
          await processAction(studentId, studentData);
        } else {
          handleUnrecognized(studentId);
        }
      } catch (err) {
        console.error("handleIdSubmit failed:", err.code || err.name, err.message);
        if (err.code === 'PERMISSION_DENIED' && !isRetry) {
          // Same likely cause as the pocket listener: a startup race where
          // sign-in resolved but the database connection hadn't finished
          // attaching that auth token yet. One short-delayed retry usually
          // clears it without the student ever seeing an error.
          console.warn("Retrying submission in 1s...");
          setTimeout(() => handleIdSubmit(true), 1000);
        } else if (err.code === 'PERMISSION_DENIED') {
          attemptRecovery('handleIdSubmit permission-denied (after retry)');
        } else {
          showOverlay('SYSTEM ERROR', 'Check connection.', 'error');
        }
      }
    }

    // MULTI-STATE CHECKS & LIMITS
    async function processAction(studentId, studentData) {
      const fullName = `${studentData.firstName} ${studentData.lastName}`;

      // Grab phone state (if enabled) plus every enabled pass type's state,
      // all at once — however many pass types this room has configured.
      const phoneRef = APP_CONFIG.enablePhoneStorage ? ref(db, `active_phones_in_class/${studentId}`) : null;
      const passRefs = {};
      APP_CONFIG.enabledPassTypes.forEach(pt => {
        passRefs[pt] = ref(db, `active_passes/${pt}/${studentId}`);
      });

      const [phoneSnap, ...passSnapsArr] = await Promise.all([
        phoneRef ? get(phoneRef) : Promise.resolve(null),
        ...APP_CONFIG.enabledPassTypes.map(pt => get(passRefs[pt]))
      ]);

      const hasPhone = phoneSnap ? phoneSnap.exists() : false;
      const passSnaps = {};   // { bathroom: snapshot, hall: snapshot, ... }
      const hasPass = {};     // { bathroom: true/false, hall: true/false, ... }
      APP_CONFIG.enabledPassTypes.forEach((pt, i) => {
        passSnaps[pt] = passSnapsArr[i];
        hasPass[pt] = passSnapsArr[i].exists();
      });

      // Helper to calculate duration in minutes/hours
      const getDuration = (startTimestamp) => {
        if (!startTimestamp) return '--';
        const diffMins = Math.floor((Date.now() - startTimestamp) / 60000);
        if (diffMins < 1) return '<1m';
        if (diffMins < 60) return `${diffMins}m`;
        return `${Math.floor(diffMins / 60)}h ${diffMins % 60}m`;
      };

      if (currentMode === 'phone') {
        if (hasPhone) {
          // --- PHONE CHECKOUT LOGIC ---
          const activeOtherPass = APP_CONFIG.enabledPassTypes.find(pt => hasPass[pt]);
          if (activeOtherPass) {
            showOverlay('ACTION DENIED', `Please return your ${PASS_TYPES[activeOtherPass].label.toLowerCase()} before retrieving your phone.`, 'error');
            clearIdField();
            return;
          }

          const prevData = phoneSnap.val();
          const oldPocket = prevData.pocket;
          const durationStr = getDuration(prevData.timestamp); // Calculate Duration

          await remove(phoneRef);
          await set(push(ref(db, 'system_logs')), {
            studentId, name: fullName, type: 'Phone', details: 'COS', timestamp: serverTimestamp(), duration: durationStr
          });

          showOverlay(`PHONE RETURNED TO BACKPACK`, `${studentData.firstName} removed phone from pocket ${oldPocket}`, 'success');
          clearIdField();
        } else {
          // --- PHONE CHECK-IN LOGIC ---
          // Uses a Firebase transaction instead of a plain set() - this
          // matters specifically because multiple physical kiosks can now
          // be checking students into the SAME room's pockets at once. A
          // plain read-then-write has a real gap: two kiosks could both
          // read "pocket 3 is free" before either has written anything,
          // and both would then successfully write pocket 3 for two
          // different students, since active_phones_in_class is keyed by
          // student ID, not by pocket number - nothing else was stopping
          // that collision. A transaction re-runs against the server's
          // freshest data if another write snuck in first, so the lowest
          // free pocket gets computed and claimed as one atomic step -
          // two simultaneous students can never be handed the same one.
          if (!selectedPocket) {
            return showOverlay('ERROR', 'No pocket selected. (All full?)', 'error');
          }

          let assignedPocket = null;
          const allPhonesRef = ref(db, 'active_phones_in_class');

          const txResult = await runTransaction(allPhonesRef, (currentPhones) => {
            currentPhones = currentPhones || {};
            const occupied = new Set(Object.values(currentPhones).map(p => p.pocket));
            let freePocket = null;
            for (let i = 1; i <= APP_CONFIG.pocketsAvailable; i++) {
              if (!occupied.has(i)) { freePocket = i; break; }
            }
            if (freePocket === null) {
              return; // abort - genuinely no pockets left, don't commit anything
            }
            assignedPocket = freePocket;
            currentPhones[studentId] = {
              studentName: fullName,
              firstName: studentData.firstName,
              lastName: studentData.lastName,
              pocket: freePocket,
              timestamp: Date.now() // not serverTimestamp() - that sentinel isn't reliable inside a transaction callback, which can run more than once before committing
            };
            return currentPhones;
          });

          if (!txResult.committed || assignedPocket === null) {
            return showOverlay('KIOSK FULL', 'No pockets are currently available. Please tell your teacher.', 'error');
          }

          await set(push(ref(db, 'system_logs')), {
            studentId, name: fullName, type: 'Phone', details: `CI-${assignedPocket}`, timestamp: serverTimestamp(), duration: '--'
          });

          showOverlay(`PHONE STORED`, `${studentData.firstName} secured phone in pocket ${assignedPocket}`, 'success');
          clearIdField();
        }
      }
      else if (APP_CONFIG.enabledPassTypes.includes(currentMode)) {
        // --- GENERIC PASS TYPE LOGIC — covers bathroom, hall, and any
        // future pass type (Goat Room, Library, ...) with no new code. ---
        const pt = currentMode;
        const meta = PASS_TYPES[pt];
        const passRef = passRefs[pt];

        if (hasPass[pt]) {
          // --- RETURN LOGIC ---
          const durationStr = getDuration(passSnaps[pt].val().timestamp);
          await remove(passRef);
          await set(push(ref(db, 'system_logs')), { studentId, name: fullName, type: meta.logCode, details: `${meta.logCode}-I`, timestamp: serverTimestamp(), duration: durationStr });
          showOverlay(`WELCOME BACK`, `${studentData.firstName} has returned`, 'success');
        } else {
          // --- CHECKOUT LOGIC ---
          if (!isModeKioskEnabled(pt)) {
            showOverlay('ACTION DENIED', `New ${meta.label} checkouts are currently disabled by the teacher.`, 'error');
            clearIdField();
            return;
          }
          if (APP_CONFIG.enablePhoneStorage && requirePhoneCheckin && !hasPhone) {
            showOverlay('ACTION DENIED', 'You must check in your phone first.', 'error');
            clearIdField();
            return;
          }
          const conflictingPass = APP_CONFIG.enabledPassTypes.find(other => other !== pt && hasPass[other]);
          if (conflictingPass) {
            showOverlay('ACTION DENIED', `You already have a ${PASS_TYPES[conflictingPass].label.toLowerCase()} out.`, 'error');
            clearIdField();
            return;
          }

          if (meta.maxConcurrent !== null && meta.maxConcurrent !== undefined) {
            const allSnap = await get(ref(db, `active_passes/${pt}`));
            const currentCount = allSnap.exists() ? Object.keys(allSnap.val()).length : 0;
            if (currentCount >= meta.maxConcurrent) {
              showOverlay('ACTION DENIED', `The ${meta.label.toLowerCase()} is currently in use by another student.`, 'error');
              clearIdField();
              return;
            }
          }

          await set(passRef, { studentName: fullName, timestamp: serverTimestamp() });
          await set(push(ref(db, 'system_logs')), { studentId, name: fullName, type: meta.logCode, details: `${meta.logCode}-O`, timestamp: serverTimestamp(), duration: '--' });
          showOverlay(`PASS CREATED`, `${studentData.firstName} signed out for ${meta.label.toLowerCase()}`, 'success');
        }
        clearIdField();
      }
    }
    
    // 8. Guest & Unrecognized Handlers
    function handleUnrecognized(studentId) {
      unrecognizedAttempts[studentId] = (unrecognizedAttempts[studentId] || 0) + 1;
      
      if (unrecognizedAttempts[studentId] >= 3) {
        guestIdDisplay.value = studentId;
        guestNameInput.value = '';
        guestModal.classList.remove('hidden');
        guestModal.classList.add('flex');
        guestNameInput.focus();
      } else {
        showOverlay('ID NOT FOUND', `Attempt ${unrecognizedAttempts[studentId]} of 3. Try again.`, 'error');
        clearIdField();
        refocusScannerCatcher();
      }
    }

    btnCancelGuest.addEventListener('click', () => {
      guestModal.classList.add('hidden');
      guestModal.classList.remove('flex');
      clearIdField();
      refocusScannerCatcher();
    });

    btnSubmitGuest.addEventListener('click', async () => {
      const fullNameRaw = guestNameInput.value.trim();
      if (!fullNameRaw) return alert("Please enter a name.");
      
      const nameParts = fullNameRaw.split(' ');
      const fName = nameParts[0];
      const lName = nameParts.slice(1).join(' ') || '';
      const sId = guestIdDisplay.value;

      try {
        await set(ref(db, `pending_roster_approvals/${sId}`), {
          firstName: fName,
          lastName: lName,
          mode: currentMode,
          pocket: currentMode === 'phone' ? selectedPocket : null,
          timestamp: serverTimestamp()
        });
        
        guestModal.classList.add('hidden');
        guestModal.classList.remove('flex');
        showOverlay('REQUEST SENT', 'Awaiting teacher approval.', 'success');
        clearIdField();
      } catch (err) {
        alert("Error sending request.");
      }
    });

    // 9. Overlay Controls
    function showOverlay(titleText, subtitleText, type) {
      overlayTitle.textContent = titleText;
      overlaySubtitle.textContent = subtitleText;
      
      if (type === 'success') {
        overlayIcon.innerHTML = '<i class="fa-solid fa-circle-check"></i>';
        overlayIcon.className = "text-7xl mb-6 text-emerald-400";
      } else {
        overlayIcon.innerHTML = '<i class="fa-solid fa-circle-xmark"></i>';
        overlayIcon.className = "text-7xl mb-6 text-red-500";
      }

      overlay.classList.remove('hidden');
      overlay.classList.add('flex');

      setTimeout(() => {
        overlay.classList.add('hidden');
        overlay.classList.remove('flex');
        if (currentMode === 'phone') autoSelectLowestPocket();
        refocusScannerCatcher();
      }, 2000); 
    }

    // ==========================================
    // CONFIG VERSION UPDATE
    // ==========================================
    function updateVersionTag() {
        const versionEl = document.getElementById('version');
        if (versionEl && typeof APP_CONFIG !== 'undefined') {
            versionEl.textContent = APP_CONFIG.version;
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', updateVersionTag);
    } else {
        updateVersionTag();
    }

  })
  .catch((error) => {
    console.error("Kiosk failed to connect to Firebase:", error.code, error.message);
    alert("Connection error. Please tell the teacher.");
  });
