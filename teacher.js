import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getDatabase, ref, get, onValue, set, push, remove } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";
import { APP_CONFIG, PASS_TYPES, escapeHtml, applyBranding } from "./config.js";

// 1. Initialize Firebase App, Auth & DB
const app = initializeApp(APP_CONFIG.firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);
const provider = new GoogleAuthProvider();
applyBranding("Dashboard");

// Rooms without phone storage (M.O.E.) don't need the Devices Checked-In
// card at all — hide it and give that freed width to the middle column
// (pass cards, manual override, etc.) instead. Rooms with phone storage
// (Chelan HS) are completely untouched by this, since the condition is
// false there and neither element's classes get changed.
if (!APP_CONFIG.enablePhoneStorage) {
    const phoneCardColumn = document.getElementById('phone-card-column');
    const middleColumn = document.getElementById('middle-column');
    if (phoneCardColumn) phoneCardColumn.classList.add('hidden');
    if (middleColumn) {
        middleColumn.classList.remove('xl:col-span-3');
        middleColumn.classList.add('xl:col-span-7'); // 3 + the freed 4 from the phone card
    }
}

// Every link to index.html/teacher.html/roster.html on this page needs to
// carry the CURRENT room forward, or clicking between dashboard/roster/kiosk
// silently drops back to the default room. Rewriting hrefs here instead of
// hand-editing every link in the HTML means new nav links added later pick
// this up automatically too.
document.querySelectorAll('a[href]').forEach(a => {
    const href = a.getAttribute('href');
    if (/^(index|teacher|roster)\.html$/.test(href)) {
        a.setAttribute('href', `${href}?room=${encodeURIComponent(APP_CONFIG.roomKey)}`);
    }
});

// Live clock — this existed in the HTML markup but was never wired up to
// any JS, so it just sat frozen at its placeholder text. Mirrors the same
// approach kiosk.js already uses.
const liveClockEl = document.getElementById('live-clock');
if (liveClockEl) {
  const tickClock = () => {
    liveClockEl.textContent = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  };
  tickClock();
  setInterval(tickClock, 1000);
}

// Running elapsed-time clocks on each bathroom/hall pass row. These need
// their own tick separate from Firebase's onValue callbacks, since Firebase
// only re-renders when the underlying DATA changes (a pass starting or
// ending) — nothing pushes an update just because a second passed. This
// reads the timestamp already stamped into each row's data-timestamp
// attribute at render time, so it works for however many rows exist at
// any moment without needing to know about them in advance.
setInterval(() => {
  document.querySelectorAll('.pass-timer').forEach(el => {
    const ts = parseInt(el.dataset.timestamp, 10);
    if (!ts) { el.textContent = '--'; return; }
    el.textContent = formatDuration(Date.now() - ts);
  });
}, 1000);

// Room label — was hardcoded as static "ROOM 176" text with no JS behind it
// at all, so it never updated per-room, even though the kiosk correctly did.
const roomLabelEl = document.getElementById('room-label');
if (roomLabelEl) roomLabelEl.textContent = `TEACHER STATION • ${APP_CONFIG.department}`;

// Header Profile Elements
const userProfile = document.getElementById("user-profile");
const userEmailSpan = document.getElementById("user-email");
const logoutBtn = document.getElementById("logout-btn");

// Login Elements
const loginOverlay = document.getElementById("login-overlay");
const loginBtn = document.getElementById("login-btn");
const loginError = document.getElementById("login-error");

// 2. Auth Guard & Allowlist Verification
onAuthStateChanged(auth, async (user) => {
  if (user) {
    if (loginError) loginError.textContent = "Verifying permissions...";

    // Check this user's own allowlist entry, keyed by their UID.
    // The security rules only let a user read their own entry, so this
    // is also the most this client is *able* to check — actual
    // enforcement happens in the rules, not here.
    //
    // This read can transiently fail right after a page load / tab switch,
    // because the Realtime Database connection can take a beat to pick up
    // the just-restored auth token. We do NOT want to treat that hiccup as
    // "not authorized" and sign the person out — only a definitive answer
    // (the read succeeded and the entry genuinely isn't true) should do that.
    const allowRef = ref(db, `allowed_teachers/${user.uid}`);
    const delays = [0, 500, 1200, 2500]; // a few attempts, backing off
    let snapshot = null;
    let lastErr = null;

    for (let i = 0; i < delays.length; i++) {
      if (delays[i] > 0) await new Promise(resolve => setTimeout(resolve, delays[i]));
      try {
        snapshot = await get(allowRef);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        console.warn(`Allowlist check attempt ${i + 1} failed:`, err.code || err.message);
      }
    }

    if (lastErr) {
      console.error("Allowlist check failed after all retries:", lastErr.code || lastErr.message);
      if (loginError) loginError.textContent = "Couldn't verify your access — check your connection and try again.";
      if (loginOverlay) loginOverlay.classList.remove("hidden");
      if (userProfile) userProfile.classList.add("hidden");
      return; // do NOT sign out — this was a connection problem, not a denial
    }

    const isAllowed = snapshot.exists() && snapshot.val() === true;

    if (isAllowed) {
      if (loginOverlay) loginOverlay.classList.add("hidden");
      if (loginError) loginError.textContent = "";
      if (userEmailSpan) userEmailSpan.textContent = user.email;
      if (userProfile) userProfile.classList.remove("hidden");

      console.log(`Teacher authorized on Dashboard: ${user.email}`);
    } else {
      if (loginError) loginError.textContent = "Access Denied: this account isn't on the approved teacher list. Ask an admin to add your UID.";
      if (userProfile) userProfile.classList.add("hidden");
      signOut(auth);
    }
  } else {
    if (loginOverlay) loginOverlay.classList.remove("hidden");
    if (userProfile) userProfile.classList.add("hidden");
  }
});

// 3. Auth Buttons
if (loginBtn) {
  loginBtn.addEventListener("click", () => signInWithPopup(auth, provider));
}

if (logoutBtn) {
  logoutBtn.addEventListener("click", () => signOut(auth));
}

// ==========================================
// 4. STATE VARIABLES
// ==========================================
let phonesData = {};
let passesData = {}; // { bathroom: {studentId: {...}}, hall: {...}, ... } - one key per APP_CONFIG.enabledPassTypes
let pendingApprovalsData = {};
let attendanceData = {}; // { studentId: { studentName, lunch, lunchCode, group, timestamp } } - only used when the room has attendance enabled
let attendanceGroupFilter = '';
let logsData = {};
let rosterData = {}; // for the Manual Pass Override search — not currently rendered as a full roster view here, just used for name lookups
let currentSort = 'last';

// ==========================================
// ATTENDANCE CARD (rooms with attendance.enabled in config.js only)
// Shows who has checked in today, their lunch choice, and their roster
// group. Data lives at active_passes/attendance/{studentId}, written by the
// kiosk's Check In / Out tab. Rooms without attendance never build this.
// ==========================================
const attendanceOn = !!(APP_CONFIG.attendance && APP_CONFIG.attendance.enabled);

function buildAttendanceCardHtml() {
    if (!attendanceOn) return '';
    const groups = APP_CONFIG.rosterGroups || [];
    const groupFilterHtml = groups.length
        ? `<select id="attendance-group-filter" class="att-select"><option value="">All groups</option>${groups.map(g => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join('')}</select>`
        : '';
    return `
        <div class="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm border-t-4 att-card-top flex flex-col min-h-[100px]">
            <div class="flex justify-between items-center mb-1.5">
                <h3 class="font-bold text-base flex items-center gap-1.5"><span>✅</span> Attendance</h3>
                <span id="dash-attendance-count" class="att-count-pill">0 Here</span>
            </div>
            <div class="flex justify-between items-center mb-1.5 bg-slate-50 rounded-lg px-2 py-1 gap-2">
                <div id="attendance-lunch-tally" class="att-tally"></div>
                ${groupFilterHtml}
            </div>
            <div id="attendance-detail" class="att-detail">No students checked in.</div>
            <div class="att-footer">
                <span id="attendance-stale-note" class="att-stale-note"></span>
                <button type="button" id="attendance-clear-all" class="att-clear-all">Check out all</button>
            </div>
        </div>
    `;
}

function renderAttendance() {
    const detail = document.getElementById('attendance-detail');
    const countEl = document.getElementById('dash-attendance-count');
    const tallyEl = document.getElementById('attendance-lunch-tally');
    if (!detail || !countEl || !tallyEl) return;

    // Only today's check-ins count as "here". Anything left over from an
    // earlier day (a student who never checked out) is set aside and noted
    // below the list; "Check out all" clears those too.
    const todayStr = new Date().toDateString();
    const everyone = Object.entries(attendanceData).map(([id, a]) => ({ id, ...a }));
    const all = everyone.filter(a => a.timestamp && new Date(a.timestamp).toDateString() === todayStr);
    const staleCount = everyone.length - all.length;
    const staleNote = document.getElementById('attendance-stale-note');
    if (staleNote) staleNote.textContent = staleCount ? `${staleCount} left over from an earlier day` : '';
    const shown = attendanceGroupFilter ? all.filter(a => (a.group || '') === attendanceGroupFilter) : all;
    shown.sort((x, y) => (x.studentName || '').localeCompare(y.studentName || ''));

    const opts = (APP_CONFIG.attendance && APP_CONFIG.attendance.lunchOptions) || [];
    countEl.textContent = `${shown.length} Here`;
    tallyEl.innerHTML = opts.map(o => `${escapeHtml(o.icon || '')} ${escapeHtml(o.label)}: <span class="att-tally-num">${shown.filter(a => a.lunchCode === o.code).length}</span>`).join(' &nbsp;&middot;&nbsp; ');

    if (shown.length === 0) {
        detail.className = 'att-detail';
        detail.innerHTML = 'No students checked in.';
        return;
    }
    detail.className = 'att-detail att-detail-filled';
    detail.innerHTML = shown.map(a => {
        const time = a.timestamp ? new Date(a.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
        const opt = opts.find(o => o.code === a.lunchCode);
        const safeId = escapeHtml(a.id);
        return `
            <div class="att-row">
                <span class="att-name">${escapeHtml(a.studentName || a.id)}</span>
                <span class="att-meta">
                    ${a.group ? `<span class="att-group-badge">${escapeHtml(a.group)}</span>` : ''}
                    <span class="att-lunch-badge" title="${escapeHtml(a.lunch || '')}">${opt ? escapeHtml(opt.icon || '') : ''} ${escapeHtml(a.lunchCode || '')}</span>
                    <span class="att-time">${escapeHtml(time)}</span>
                    <button type="button" onclick="attendanceCheckOut('${safeId}')" class="att-x" title="Check out ${escapeHtml(a.studentName || a.id)}">&times;</button>
                </span>
            </div>
        `;
    }).join('');
}

window.attendanceCheckOut = async (id) => {
    const a = attendanceData[id];
    if (!a) return;
    const now = Date.now();
    try {
        await push(ref(db, 'system_logs'), {
            studentId: id, name: a.studentName || id, type: 'AT', details: 'AT-CO (Staff)', timestamp: now, duration: formatDuration(now - (a.timestamp || now))
        });
        await remove(ref(db, `active_passes/attendance/${id}`));
        await clearStudentPasses([id], now);
    } catch (err) {
        console.error("Attendance check-out error:", err);
        alert("Couldn't check that student out: " + err.message);
    }
};

// Logs a return and removes any open passes (bathroom/hall) so a student who is
// checked out for the day doesn't stay listed as "out" on a pass.
async function clearStudentPasses(studentIds, now) {
    for (const pt of APP_CONFIG.enabledPassTypes) {
        const meta = PASS_TYPES[pt];
        for (const id of studentIds) {
            const pass = (passesData[pt] || {})[id];
            if (!pass) continue;
            await push(ref(db, 'system_logs'), {
                studentId: id, name: pass.studentName || id, type: meta.logCode, details: `${meta.logCode}-I`, timestamp: now, duration: formatDuration(now - (pass.timestamp || now))
            });
            await remove(ref(db, `active_passes/${pt}/${id}`));
        }
    }
}

window.attendanceCheckOutAll = async () => {
    const ids = Object.keys(attendanceData);
    const passIds = new Set();
    APP_CONFIG.enabledPassTypes.forEach(pt => Object.keys(passesData[pt] || {}).forEach(id => passIds.add(id)));
    if (ids.length === 0 && passIds.size === 0) return;
    const passNote = passIds.size ? ` and bring back ${passIds.size} on a bathroom/hall pass` : '';
    if (!confirm(`Check out all ${ids.length} students for the day${passNote}?`)) return;
    const now = Date.now();
    try {
        for (const id of ids) {
            const a = attendanceData[id];
            await push(ref(db, 'system_logs'), {
                studentId: id, name: a.studentName || id, type: 'AT', details: 'AT-CO (Staff)', timestamp: now, duration: formatDuration(now - (a.timestamp || now))
            });
        }
        await remove(ref(db, 'active_passes/attendance'));
        await clearStudentPasses([...passIds], now);
    } catch (err) {
        console.error("Attendance check-out-all error:", err);
        alert("Couldn't check everyone out: " + err.message);
    }
};

// ==========================================
// 5. UTILITY FUNCTIONS
// ==========================================
// CSV-cell escaping only (used by exportLogsToCSV below). This does NOT make
// text safe to insert into innerHTML — use escapeHtml() from config.js for that.
function escapeAttr(str) {
    return String(str || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

function formatDuration(ms) {
    if (!ms || ms < 0) return '--';
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes === 0) return `${seconds}s`;
    return `${minutes}m ${seconds}s`;
}

function parseDurationToDecimalMinutes(durationStr) {
    if (!durationStr || durationStr === '--') return '--';
    if (durationStr === '<1m') return '0.5';

    let totalMinutes = 0;
    let foundMatch = false;

    // Extract hours
    const hourMatch = durationStr.match(/(\d+)h/);
    if (hourMatch) { totalMinutes += parseInt(hourMatch[1], 10) * 60; foundMatch = true; }

    // Extract minutes
    const minMatch = durationStr.match(/(\d+)m/);
    if (minMatch) { totalMinutes += parseInt(minMatch[1], 10); foundMatch = true; }
    
    // Extract seconds (from dashboard manual checkouts)
    const secMatch = durationStr.match(/(\d+)s/);
    if (secMatch) { totalMinutes += parseInt(secMatch[1], 10) / 60; foundMatch = true; }

    if (!foundMatch) return durationStr; // Fallback for plain text

    return totalMinutes.toFixed(1);
}

// ==========================================
// 6. GLOBAL DASHBOARD ACTIONS (Attached to Window)
// ==========================================
window.exportLogsToCSV = () => {
    const keys = Object.keys(logsData).reverse();
    if (keys.length === 0) {
        alert("No logs to export.");
        return;
    }
    
    let csvContent = "data:text/csv;charset=utf-8,";
    csvContent += "Date,Time,Student,Action,Code,Duration (Minutes)\n";
    
    keys.forEach(k => {
        const l = logsData[k];
        const dateObj = l.timestamp ? new Date(l.timestamp) : new Date();
        const dateStr = dateObj.toLocaleDateString();
        const timeStr = dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        
        const name = `"${escapeAttr(l.name || l.studentId || 'Unknown')}"`;
        const actionType = `"${escapeAttr(l.type || 'Phone')}"`;
        const detailsCode = `"${escapeAttr(l.details || l.action || '--')}"`;
        
        // Parse the duration string to decimal before exporting
        const rawDuration = l.duration || '--';
        const parsedDuration = parseDurationToDecimalMinutes(rawDuration);
        const duration = `"${escapeAttr(parsedDuration)}"`;
        
        csvContent += `${dateStr},${timeStr},${name},${actionType},${detailsCode},${duration}\n`;
    });
    
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `Chelan_Logs_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
};

window.clearLogs = async () => {
    const keys = Object.keys(logsData);
    if (keys.length === 0) {
        alert("Logs are already empty.");
        return;
    }
    if (!confirm(`⚠️ Are you sure you want to permanently delete all ${keys.length} log entries?\n\nThis cannot be undone. We recommend Exporting to CSV first.`)) {
        return;
    }
    
    try {
        await remove(ref(db, 'system_logs'));
    } catch (err) {
        console.error("Clear logs error:", err);
        alert("Error clearing logs: " + err.message);
    }
};

window.setPhoneSort = (sortType) => {
    currentSort = sortType;
    const btnFirst = document.getElementById('sort-first');
    const btnLast = document.getElementById('sort-last');
    const btnPocket = document.getElementById('sort-pocket');

    const activeClass = "bg-chelan text-white px-2 py-0.5 rounded-md";
    const inactiveClass = "px-2 py-0.5 rounded-md hover:text-slate-800";

    if (btnFirst) btnFirst.className = sortType === 'first' ? activeClass : inactiveClass;
    if (btnLast) btnLast.className = sortType === 'last' ? activeClass : inactiveClass;
    if (btnPocket) btnPocket.className = sortType === 'pocket' ? activeClass : inactiveClass;

    renderPhones();
};

window.forceRemovePhone = async (id) => {
    const phone = phonesData[id];
    const studentName = phone ? (phone.studentName || `${phone.firstName || ''} ${phone.lastName || ''}`.trim()) : id;
    const now = Date.now();

    try {
        // Phone
        if (phone) {
            const duration = formatDuration(now - (phone.timestamp || now));
            await remove(ref(db, `active_phones_in_class/${id}`));
            await push(ref(db, 'system_logs'), {
                studentId: id, name: studentName, type: 'Phone', details: 'COT', timestamp: now, duration: duration
            });
        }

        // Also close out any active pass this student still has open, of
        // ANY enabled pass type — "Check Out" for a student should mean
        // fully checked out, not just their phone, same as what Check Out
        // All does across everyone.
        for (const pt of APP_CONFIG.enabledPassTypes) {
            const activePass = (passesData[pt] || {})[id];
            if (activePass) {
                const meta = PASS_TYPES[pt];
                const duration = formatDuration(now - (activePass.timestamp || now));
                await remove(ref(db, `active_passes/${pt}/${id}`));
                await push(ref(db, 'system_logs'), {
                    studentId: id, name: studentName, type: meta.logCode, details: `${meta.logCode}-I`, timestamp: now, duration: duration
                });
            }
        }
    } catch (err) {
        console.error("Checkout error:", err);
    }
};

window.clearAllActivity = async () => {
    const phoneKeys = Object.keys(phonesData);
    const passKeysByType = {};
    let totalPassItems = 0;
    APP_CONFIG.enabledPassTypes.forEach(pt => {
        passKeysByType[pt] = Object.keys(passesData[pt] || {});
        totalPassItems += passKeysByType[pt].length;
    });
    const totalItems = phoneKeys.length + totalPassItems;

    if (totalItems === 0) return;
    if (!confirm(`Are you sure you want to Check Out ALL ${totalItems} active items (Phones & Passes)?`)) return;

    const now = Date.now();

    try {
        for (const id of phoneKeys) {
            const phone = phonesData[id];
            const studentName = phone ? (phone.studentName || `${phone.firstName || ''} ${phone.lastName || ''}`.trim()) : id;
            const duration = formatDuration(now - (phone.timestamp || now));
            
            await push(ref(db, 'system_logs'), {
                studentId: id, name: studentName, type: 'Phone', details: 'COA', timestamp: now, duration: duration
            });
        }
        await remove(ref(db, 'active_phones_in_class'));

        for (const pt of APP_CONFIG.enabledPassTypes) {
            const meta = PASS_TYPES[pt];
            for (const id of passKeysByType[pt]) {
                const pass = (passesData[pt] || {})[id];
                const name = pass ? pass.studentName : id;
                const duration = formatDuration(now - (pass.timestamp || now));

                await push(ref(db, 'system_logs'), {
                    studentId: id, name: name, type: meta.logCode, details: `${meta.logCode}-I`, timestamp: now, duration: duration
                });
            }
            await remove(ref(db, `active_passes/${pt}`));
        }

    } catch (err) {
        console.error("Clear all error:", err);
    }
};

window.forceClearPass = async (passType, studentId) => {
    const meta = PASS_TYPES[passType];
    const node = `active_passes/${passType}`;

    const passData = (passesData[passType] || {})[studentId];
    const name = passData ? passData.studentName : studentId;
    
    const now = Date.now();
    const duration = passData ? formatDuration(now - passData.timestamp) : '--';

    try {
        await remove(ref(db, `${node}/${studentId}`));
        await push(ref(db, 'system_logs'), {
            studentId: studentId,
            name: name,
            type: meta.logCode,
            details: `${meta.logCode}-I`,
            timestamp: now,
            duration: duration
        });
    } catch (err) {
        console.error("Clear pass error:", err);
    }
};

window.issueManualPass = async (studentId, passType) => {
    const student = rosterData[studentId];
    if (!student) return;
    const fullName = `${student.firstName} ${student.lastName}`.trim();
    const meta = PASS_TYPES[passType];

    // Deliberately does NOT check for an active phone check-in, and
    // deliberately does NOT check maxConcurrent (e.g. the "only one
    // bathroom pass at a time" limit) — both are exactly the restrictions
    // this button exists to bypass. Only "already has some other pass out"
    // still applies, same as the kiosk enforces.
    const alreadyHasAnyPass = APP_CONFIG.enabledPassTypes.some(pt => (passesData[pt] || {})[studentId]);
    if (alreadyHasAnyPass) {
        alert(`${fullName} already has an active pass out.`);
        return;
    }

    const node = `active_passes/${passType}`;

    const now = Date.now();
    try {
        await set(ref(db, `${node}/${studentId}`), { studentName: fullName, timestamp: now });
        await push(ref(db, 'system_logs'), {
            studentId: studentId,
            name: fullName,
            type: meta.logCode,
            details: `${meta.logCode}-O (Staff)`,
            timestamp: now,
            duration: '--'
        });
        if (manualPassSearch) manualPassSearch.value = '';
        renderManualPassResults('');
    } catch (err) {
        console.error("Manual pass issue error:", err);
        alert("Error issuing pass: " + err.message);
    }
};

// ==========================================
// MANUAL PASS OVERRIDE — SEARCH
// ==========================================
const manualPassSearch = document.getElementById('manual-pass-search');
const manualPassResults = document.getElementById('manual-pass-results');

function renderManualPassResults(query) {
    if (!manualPassResults) return;
    const q = query.trim().toLowerCase();
    if (!q) { manualPassResults.innerHTML = ''; return; }

    const matches = Object.entries(rosterData).filter(([id, s]) => {
        const full = `${s.firstName || ''} ${s.lastName || ''}`.toLowerCase();
        return id.toLowerCase().includes(q) || full.includes(q);
    }).slice(0, 8); // cap the list so it can't grow unbounded on a broad search

    if (matches.length === 0) {
        manualPassResults.innerHTML = `<p class="text-[11px] text-slate-400 italic px-1">No matching students.</p>`;
        return;
    }

    manualPassResults.innerHTML = matches.map(([id, s]) => {
        const name = escapeHtml(`${s.firstName || ''} ${s.lastName || ''}`.trim());
        const safeId = escapeHtml(id);
        const buttons = APP_CONFIG.enabledPassTypes.map(pt => {
            const meta = PASS_TYPES[pt];
            return `<button onclick="issueManualPass('${safeId}', '${pt}')" class="bg-${meta.color}-100 hover:bg-${meta.color}-200 text-${meta.color}-700 px-2 py-1 rounded font-bold text-[10px]" title="Issue ${escapeHtml(meta.label)}">${meta.icon} ${meta.logCode}</button>`;
        }).join('');
        return `
            <div class="flex items-center justify-between bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 text-xs">
                <span class="font-bold text-slate-800 truncate mr-1">${name}</span>
                <div class="flex gap-1 flex-shrink-0">${buttons}</div>
            </div>
        `;
    }).join('');
}

if (manualPassSearch) {
    manualPassSearch.addEventListener('input', (e) => renderManualPassResults(e.target.value));
}

// ==========================================
// PASS REMINDER — recurring toast every 5 minutes per student, for any
// enabled pass type (originally bathroom-only; generalized here since the
// underlying data is now unified across pass types anyway).
// ==========================================
let reminderLastShown = {}; // { bathroom: {studentId: lastThreshold}, hall: {...}, ... }
APP_CONFIG.enabledPassTypes.forEach(pt => { reminderLastShown[pt] = {}; });

function showToast(title, message) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'pointer-events-auto bg-amber-50 border-2 border-amber-300 rounded-2xl shadow-lg p-3.5 max-w-xs';
    toast.innerHTML = `
        <div class="flex justify-between items-start gap-2">
            <div>
                <p class="font-black text-amber-900 text-xs uppercase tracking-wider mb-1">${escapeHtml(title)}</p>
                <p class="text-xs text-amber-800 font-medium">${escapeHtml(message)}</p>
            </div>
            <button class="text-amber-700 hover:text-amber-900 font-bold text-sm leading-none flex-shrink-0" aria-label="Dismiss">&times;</button>
        </div>
    `;
    toast.querySelector('button').addEventListener('click', () => toast.remove());
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 20000); // auto-dismiss after 20s if not manually closed
}

function checkPassReminders() {
    APP_CONFIG.enabledPassTypes.forEach(pt => {
        const data = passesData[pt] || {};
        const activeIds = new Set(Object.keys(data));
        const lastShownForType = reminderLastShown[pt];

        // Clean up tracking for anyone no longer out (they returned).
        for (const id of Object.keys(lastShownForType)) {
            if (!activeIds.has(id)) delete lastShownForType[id];
        }

        for (const [id, passInfo] of Object.entries(data)) {
            if (!passInfo.timestamp) continue;
            const elapsedMin = Math.floor((Date.now() - passInfo.timestamp) / 60000);
            const lastShown = lastShownForType[id] || 0;
            const nextThreshold = lastShown + 5;
            if (elapsedMin >= nextThreshold) {
                lastShownForType[id] = nextThreshold;
                showToast(`${PASS_TYPES[pt].label} Reminder`, `${passInfo.studentName || id} has been out for ${elapsedMin} minute${elapsedMin === 1 ? '' : 's'}.`);
            }
        }
    });
}

setInterval(checkPassReminders, 15000); // check every 15s so a threshold isn't missed by much

window.approvePendingStudent = async (id) => {
    const item = pendingApprovalsData[id];
    if (!item) return;

    const firstName = item.firstName || '';
    const lastName = item.lastName || '';
    const fullName = `${firstName} ${lastName}`.trim() || id;
    const now = Date.now();
    // Older pending requests (from before the mode field existed) never
    // recorded which tab they came from — treat those as phone, matching
    // the old behavior, since a set pocket is a reliable enough sign.
    const mode = item.mode || (item.pocket !== undefined && item.pocket !== null ? 'phone' : null);

    try {
        await set(ref(db, `classroom_roster/${id}`), { firstName, lastName });

        if (mode === 'phone') {
            const pocketNum = item.pocket !== undefined && item.pocket !== null ? item.pocket : 0;
            await set(ref(db, `active_phones_in_class/${id}`), {
                studentName: fullName, firstName, lastName, pocket: pocketNum, timestamp: now
            });
            const formattedPocket = String(pocketNum).padStart(2, '0');
            await push(ref(db, 'system_logs'), {
                studentId: id, name: fullName, type: 'Phone', details: `CI-${formattedPocket}`, timestamp: now, duration: '--'
            });
        } else if (mode && APP_CONFIG.enabledPassTypes.includes(mode)) {
            const meta = PASS_TYPES[mode];
            await set(ref(db, `active_passes/${mode}/${id}`), { studentName: fullName, timestamp: now });
            await push(ref(db, 'system_logs'), {
                studentId: id, name: fullName, type: meta.logCode, details: `${meta.logCode}-O`, timestamp: now, duration: '--'
            });
        }
        // If mode is missing/unrecognized, the student still gets added to
        // the roster above — just without an automatic check-in, since we
        // don't know which one they actually wanted.

        await remove(ref(db, `pending_roster_approvals/${id}`));

    } catch (err) {
        console.error("Approval error:", err);
        alert("Error approving student: " + err.message);
    }
};

window.rejectPendingStudent = (id) => {
    remove(ref(db, `pending_roster_approvals/${id}`));
};

window.handleLogSearch = () => {
    renderLogs(logsData);
};

// ==========================================
// 7. QUICK ADD FORM LISTENER
// ==========================================
const form = document.getElementById('quick-add-form');
// Rooms that define rosterGroups get a group dropdown on Quick Add.
let addGroupSelect = null;
if (form && (APP_CONFIG.rosterGroups || []).length) {
    addGroupSelect = document.createElement('select');
    addGroupSelect.id = 'add-student-group';
    addGroupSelect.className = 'w-full text-xs px-2.5 py-1.5 border border-slate-200 rounded-lg bg-slate-50';
    addGroupSelect.innerHTML = '<option value="">No group</option>' + APP_CONFIG.rosterGroups.map(g => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join('');
    form.insertBefore(addGroupSelect, document.getElementById('add-btn'));
}
if (form) {
    form.addEventListener('submit', (e) => {
        e.preventDefault();
        const btn = document.getElementById('add-btn');
        const idInput = document.getElementById('add-student-id');
        const fInput = document.getElementById('add-student-fname');
        const lInput = document.getElementById('add-student-lname');

        const studentId = idInput.value.trim();
        const firstName = fInput.value.trim();
        const lastName = lInput.value.trim();

        if (!studentId || !firstName || !lastName) {
            alert("Please fill in all 3 fields.");
            return;
        }

        btn.disabled = true;
        btn.textContent = "Saving...";

        set(ref(db, 'classroom_roster/' + studentId), {
            firstName: firstName,
            lastName: lastName,
            ...(addGroupSelect && addGroupSelect.value ? { group: addGroupSelect.value } : {})
        })
        .then(() => {
            btn.textContent = "✓ Added!";
            btn.classList.remove('bg-chelan');
            btn.classList.add('bg-green-600');
            form.reset();
            
            setTimeout(() => {
                btn.textContent = "+ Add to Roster";
                btn.classList.remove('bg-green-600');
                btn.classList.add('bg-chelan');
                btn.disabled = false;
            }, 1500);
        })
        .catch((error) => {
            alert("Error saving: " + error.message);
            btn.disabled = false;
        });
    });
}

// ==========================================
// 8. FIREBASE REALTIME LISTENERS
// ==========================================
// Builds one pass card per entry in APP_CONFIG.enabledPassTypes, in the
// same visual style the old hardcoded bathroom/hall cards used. This is
// what lets a new pass type (Goat Room, Library) show up on the dashboard
// just by being listed in config — no HTML or JS changes needed here.
const passCardsContainer = document.getElementById('pass-cards-container');
if (passCardsContainer) {
    passCardsContainer.innerHTML = buildAttendanceCardHtml() + APP_CONFIG.enabledPassTypes.map(pt => {
        const meta = PASS_TYPES[pt];
        return `
            <div class="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm border-t-4 border-t-${meta.color}-600 flex flex-col min-h-[100px]">
                <div class="flex justify-between items-center mb-1.5">
                    <h3 class="font-bold text-base flex items-center gap-1.5"><span>${meta.icon}</span> ${escapeHtml(meta.label)}es</h3>
                    <span id="dash-pass-count-${pt}" class="bg-${meta.color}-50 text-${meta.color}-700 text-xs font-bold px-2 py-0.5 rounded-md border border-${meta.color}-100">0 Out</span>
                </div>
                <div class="flex justify-between items-center mb-1.5 bg-slate-50 rounded-lg px-2 py-1">
                    <span class="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Kiosk Self-Checkout</span>
                    <button type="button" id="toggle-kiosk-${pt}" class="pass-toggle" data-enabled="true" aria-label="Toggle kiosk-issued ${escapeHtml(meta.label.toLowerCase())}es">
                        <span class="pass-toggle-knob"></span>
                    </button>
                </div>
                <div id="pass-status-detail-${pt}" class="flex-grow flex items-start flex-col gap-1 overflow-y-auto custom-scrollbar text-xs text-slate-400 italic pt-1">
                    No students out.
                </div>
            </div>
        `;
    }).join('');
}

if (attendanceOn) {
    onValue(ref(db, 'active_passes/attendance'), s => {
        attendanceData = s.val() || {};
        renderAttendance();
    });
    const attGroupFilter = document.getElementById('attendance-group-filter');
    if (attGroupFilter) {
        attGroupFilter.addEventListener('change', () => {
            attendanceGroupFilter = attGroupFilter.value;
            renderAttendance();
        });
    }
    const attClearAll = document.getElementById('attendance-clear-all');
    if (attClearAll) attClearAll.addEventListener('click', () => window.attendanceCheckOutAll());
}

onValue(ref(db, 'active_phones_in_class'), s => {
    phonesData = s.val() || {};
    renderPhones();
});

// One listener per enabled pass type, instead of one hand-written listener
// per hardcoded type. Adding Goat Room later means this loop just runs one
// more time — nothing here needs to change.
APP_CONFIG.enabledPassTypes.forEach(pt => {
    onValue(ref(db, `active_passes/${pt}`), s => {
        passesData[pt] = s.val() || {};
        renderPasses(pt, passesData[pt]);
        renderPhones();
    });
});

// Kiosk self-checkout toggles — one per enabled pass type. Default to
// enabled (true) when the node doesn't exist yet, matching kiosk.js's own
// default.
const kioskToggleButtons = {}; // { bathroom: <button element>, hall: <button element>, ... }
APP_CONFIG.enabledPassTypes.forEach(pt => {
    kioskToggleButtons[pt] = document.getElementById(`toggle-kiosk-${pt}`);
});

// Separate from the per-pass-type toggles above: this one controls whether
// a phone must be checked in at all before a student can get ANY pass.
// Defaults to true (required) to match the kiosk's existing behavior —
// flipping it off lets students get passes with no phone checked in.
const toggleRequirePhone = document.getElementById('toggle-require-phone');

onValue(ref(db, 'kiosk_settings'), s => {
    const data = s.val() || {};
    APP_CONFIG.enabledPassTypes.forEach(pt => {
        const enabled = (data[pt] && data[pt].enabled) !== false;
        const btn = kioskToggleButtons[pt];
        if (btn) btn.setAttribute('data-enabled', enabled ? 'true' : 'false');
    });
    const requirePhone = data.requirePhoneCheckin !== false;
    if (toggleRequirePhone) toggleRequirePhone.setAttribute('data-enabled', requirePhone ? 'true' : 'false');
});

APP_CONFIG.enabledPassTypes.forEach(pt => {
    const btn = kioskToggleButtons[pt];
    if (!btn) return;
    btn.addEventListener('click', () => {
        const currentlyEnabled = btn.getAttribute('data-enabled') === 'true';
        set(ref(db, `kiosk_settings/${pt}/enabled`), !currentlyEnabled).catch(err => {
            console.error(`Toggle ${pt} kiosk setting failed:`, err);
            alert("Couldn't update the setting: " + err.message);
        });
    });
});

if (toggleRequirePhone) {
    toggleRequirePhone.addEventListener('click', () => {
        const currentlyRequired = toggleRequirePhone.getAttribute('data-enabled') === 'true';
        set(ref(db, 'kiosk_settings/requirePhoneCheckin'), !currentlyRequired).catch(err => {
            console.error('Toggle require-phone setting failed:', err);
            alert("Couldn't update the setting: " + err.message);
        });
    });
}

onValue(ref(db, 'pending_roster_approvals'), s => {
    pendingApprovalsData = s.val() || {};
    renderPendingApprovals();
});
onValue(ref(db, 'system_logs'), s => {
    logsData = s.val() || {};
    renderLogs(logsData);
    updateStatsOverview();
});
onValue(ref(db, 'classroom_roster'), s => {
    rosterData = s.val() || {};
});

// ==========================================
// 9. RENDER FUNCTIONS
// ==========================================
function updateStatsOverview() {
    const todayStr = new Date().toDateString();
    const logKeys = Object.keys(logsData);

    let checkinCount = 0;
    let passCount = 0;
    const hourCounts = {};

    logKeys.forEach(k => {
        const item = logsData[k];
        if (!item.timestamp) return;

        const itemDate = new Date(item.timestamp);
        if (itemDate.toDateString() === todayStr) {
            const type = (item.type || '').toUpperCase();
            const details = (item.details || '').toUpperCase();

            if (type === 'PHONE' && (details.includes('CI-') || details.includes('COS') || details.includes('COT') || details.includes('COA') || details.includes('COED'))) {
                checkinCount++;
            }

            if (type === 'AT' && details.startsWith('AT-CI')) {
                checkinCount++;
            }

            const passLogCodes = APP_CONFIG.enabledPassTypes.map(pt => PASS_TYPES[pt].logCode);
            if (passLogCodes.includes(type) || passLogCodes.some(code => details.includes(code + '-'))) {
                passCount++;
            }

            const hour = itemDate.getHours();
            hourCounts[hour] = (hourCounts[hour] || 0) + 1;
        }
    });

    let peakHour = null;
    let maxCount = 0;
    Object.keys(hourCounts).forEach(h => {
        if (hourCounts[h] > maxCount) {
            maxCount = hourCounts[h];
            peakHour = parseInt(h);
        }
    });

    // Bar chart across the school day, 8am-4pm (8 one-hour buckets).
    // Reuses the same hourCounts already computed above for Peak Time.
    const chartHours = [8, 9, 10, 11, 12, 13, 14, 15];
    const chartMax = Math.max(1, ...chartHours.map(h => hourCounts[h] || 0)); // avoid divide-by-zero when nothing's happened yet
    const chartEl = document.getElementById('activity-chart');
    if (chartEl) {
        chartEl.innerHTML = chartHours.map(h => {
            const count = hourCounts[h] || 0;
            const pct = Math.max(4, Math.round((count / chartMax) * 100)); // 4% floor so a zero hour still shows a visible sliver
            const isPeak = h === peakHour && count > 0;
            const label = `${h % 12 || 12}${h >= 12 ? 'PM' : 'AM'}: ${count} event${count === 1 ? '' : 's'}`;
            return `<div class="flex-1 ${isPeak ? 'bg-amber-400' : 'bg-slate-200'} rounded-t" style="height:${pct}%" title="${label}"></div>`;
        }).join('');
    }

    const statCheckins = document.getElementById('stat-checkins');
    const statPasses = document.getElementById('stat-passes');

    if (statCheckins) statCheckins.textContent = checkinCount;
    if (statPasses) statPasses.textContent = passCount;
}

function renderPendingApprovals() {
    const card = document.getElementById('pending-approvals-card');
    const list = document.getElementById('pending-approvals-list');
    const badge = document.getElementById('pending-count-badge');
    
    if (!card || !list || !badge) return;

    const keys = Object.keys(pendingApprovalsData);
    badge.textContent = keys.length;

    if (keys.length === 0) {
        card.classList.add('hidden');
        list.innerHTML = '';
        return;
    }

    card.classList.remove('hidden');
    list.innerHTML = keys.map(id => {
        const item = pendingApprovalsData[id];
        const safeId = escapeAttr(id);
        const displayId = escapeHtml(id);
        const displayFirst = escapeHtml(item.firstName || '');
        const displayLast = escapeHtml(item.lastName || '');

        return `
            <div class="flex items-center justify-between bg-white p-2 rounded-xl border border-amber-200 shadow-sm text-xs">
                <div class="flex items-center gap-1.5">
                    <span class="font-mono font-bold bg-amber-100 text-amber-900 px-1.5 py-0.5 rounded border border-amber-300">${displayId}</span>
                    <div class="flex flex-col">
                        <span class="font-bold text-slate-800 leading-tight">${displayFirst} ${displayLast}</span>
                        ${item.pocket !== undefined ? `<span class="text-[10px] text-green-700 font-bold">Pocket #${item.pocket}</span>` : ''}
                    </div>
                </div>
                <div class="flex items-center gap-1">
                    <button onclick="approvePendingStudent('${safeId}')" class="bg-green-700 hover:bg-green-800 text-white font-bold px-2 py-1 rounded-lg transition shadow-sm">✓</button>
                    <button onclick="rejectPendingStudent('${safeId}')" class="bg-red-600 hover:bg-red-700 text-white font-bold px-2 py-1 rounded-lg transition shadow-sm">✕</button>
                </div>
            </div>
        `;
    }).join('');
}

function renderPhones() {
    const list = document.getElementById('active-phones-list');
    if (!list) return;

    const keys = Object.keys(phonesData);
    const countEl = document.getElementById('dash-phone-count');
    if (countEl) countEl.textContent = `${keys.length} Students`;
    
    if (keys.length === 0) {
        list.innerHTML = '<p class="text-xs text-slate-400 italic col-span-2">No phones currently checked in.</p>';
        return;
    }

    const items = keys.map(id => ({ id, ...phonesData[id] }));

    items.sort((a, b) => {
        if (currentSort === 'first') {
            return (a.firstName || a.studentName || '').localeCompare(b.firstName || b.studentName || '');
        } else if (currentSort === 'pocket') {
            return (parseInt(a.pocket) || 0) - (parseInt(b.pocket) || 0);
        } else {
            return (a.lastName || a.studentName || '').localeCompare(b.lastName || b.studentName || '');
        }
    });

    const total = items.length;
    const mid = Math.ceil(total / 2);
    const col1 = items.slice(0, mid);
    const col2 = items.slice(mid);

    const gridOrderedItems = [];
    for (let i = 0; i < mid; i++) {
        if (col1[i]) gridOrderedItems.push(col1[i]);
        if (col2[i]) gridOrderedItems.push(col2[i]);
    }

    list.innerHTML = gridOrderedItems.map(item => {
        const id = item.id;
        const activePassType = APP_CONFIG.enabledPassTypes.find(pt => (passesData[pt] || {})[id]);

        let containerClass = "border-green-200 bg-green-50/70";
        let badgeClass = "text-green-800 bg-green-200/80";
        let passTag = "";

        if (activePassType) {
            const meta = PASS_TYPES[activePassType];
            containerClass = `border-${meta.color}-300 bg-${meta.color}-100/90 shadow-sm`;
            badgeClass = `text-${meta.color}-900 bg-${meta.color}-200 font-black`;
            passTag = `<span class="text-[9px] bg-${meta.color}-600 text-white font-black px-1 py-0.5 rounded uppercase">${meta.logCode}</span>`;
        }

        const displayNameRaw = item.studentName || `${item.firstName || ''} ${item.lastName || ''}`.trim() || 'Student';
        const displayName = escapeHtml(displayNameRaw);

        return `
            <div class="flex items-center justify-between border ${containerClass} rounded-xl px-2.5 py-2 transition text-xs">
                <div class="flex items-center gap-1.5 overflow-hidden mr-1">
                    ${passTag}
                    <span class="font-bold text-slate-800 truncate" title="${displayName}">${displayName}</span>
                </div>
                <div class="flex items-center gap-1.5 flex-shrink-0">
                    <span class="text-[11px] ${badgeClass} px-2 py-0.5 rounded-md font-mono font-bold">${item.pocket || 0}</span>
                    <button onclick="forceRemovePhone('${id}')" title="Check Out" class="text-red-500 hover:text-red-700 font-bold text-sm leading-none">&times;</button>
                </div>
            </div>
        `;
    }).join('');
}

function renderPasses(passType, data) {
    const keys = Object.keys(data);
    const meta = PASS_TYPES[passType];
    const countEl = document.getElementById(`dash-pass-count-${passType}`);
    if (countEl) countEl.textContent = `${keys.length} Out`;
    const d = document.getElementById(`pass-status-detail-${passType}`);
    if (d) {
        d.innerHTML = keys.length ? keys.map(k => `<div class="w-full flex justify-between items-center mb-1"><span class="font-bold text-slate-800 not-italic">${escapeHtml(data[k].studentName)}</span><span class="pass-timer font-mono text-slate-500 not-italic mx-2" data-timestamp="${data[k].timestamp || ''}">--</span><button onclick="forceClearPass('${passType}', '${k}')" class="text-xs bg-${meta.color}-100 hover:bg-${meta.color}-200 text-${meta.color}-700 px-2 py-0.5 rounded font-bold not-italic transition">Return</button></div>`).join('') : 'No students out.';
    }
}

function renderLogs(data) {
    const tableBody = document.getElementById('logs-table-body');
    const logCount = document.getElementById('log-count');
    if (!tableBody) return;

    const keys = Object.keys(data).reverse();
    if (logCount) logCount.textContent = `${keys.length}`;
    
    if (keys.length === 0) {
        tableBody.innerHTML = '<tr><td colspan="5" class="px-3 py-4 text-center text-slate-400 text-xs italic">No activity logged yet.</td></tr>';
        return;
    }
    
    const searchInput = document.getElementById('log-search');
    let filterText = searchInput ? searchInput.value.toLowerCase().trim() : '';

    const filteredKeys = keys.filter(k => {
        const l = data[k];
        const nameMatch = (l.name || l.studentId || '').toLowerCase().includes(filterText);
        const typeMatch = (l.type || l.action || '').toLowerCase().includes(filterText);
        const detailMatch = (l.details || '').toLowerCase().includes(filterText);
        
        return nameMatch || typeMatch || detailMatch;
    });

    if (filteredKeys.length === 0) {
        tableBody.innerHTML = '<tr><td colspan="5" class="px-3 py-4 text-center text-slate-400 text-xs italic">No matching records found.</td></tr>';
        return;
    }

    tableBody.innerHTML = filteredKeys.map(k => {
        const l = data[k];
        const timeStr = l.timestamp ? new Date(l.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--:--';
        const name = escapeHtml(l.name || l.studentId || 'Unknown');
        
        let actionType = l.type || 'Phone';
        let detailsCode = l.details || l.action || '--';
        let duration = l.duration || '--';

        let badgeClass = "bg-green-100 text-green-800 border-green-300";

        // Match this log entry's type/details against every enabled pass
        // type's logCode (BP, HP, GR, ...) instead of hardcoding just BP/HP
        // — this is what makes Goat Room (and any future pass type) show
        // up correctly here automatically, with no further code changes.
        const matchedPassType = APP_CONFIG.enabledPassTypes.find(pt => {
            const code = PASS_TYPES[pt].logCode;
            return actionType === code || detailsCode.startsWith(code);
        });

        if (actionType === 'AT' || detailsCode.startsWith('AT-')) {
            actionType = 'AT';
            badgeClass = 'bg-emerald-100 text-emerald-800 border-emerald-300';
        } else if (matchedPassType) {
            const meta = PASS_TYPES[matchedPassType];
            actionType = meta.logCode;
            badgeClass = `bg-${meta.color}-100 text-${meta.color}-800 border-${meta.color}-300`;
        } else {
            actionType = 'Phone';
        }

        return `
            <tr class="hover:bg-slate-100 transition border-b border-slate-50 last:border-0">
                <td class="px-3 py-2 font-mono text-slate-500 text-xs truncate">${timeStr}</td>
                <td class="px-2 py-2 font-bold text-slate-800 max-w-[120px] truncate" title="${name}">${name}</td>
                <td class="px-2 py-2 text-center">
                    <span class="px-2 py-0.5 rounded text-[10px] font-black uppercase border ${badgeClass}">
                        ${actionType}
                    </span>
                </td>
                <td class="px-2 py-2 font-mono text-xs font-semibold text-slate-500 text-center truncate">${duration}</td>
                <td class="px-3 py-2 font-mono font-bold text-xs text-slate-600 text-center">${detailsCode}</td>
            </tr>
        `;
    }).join('');
}

// ==========================================
// 10. VERSION TAG & MOBILE MENU
// ==========================================
function updateVersionTag() {
    const versionEl = document.getElementById('version');
    if (versionEl && typeof APP_CONFIG !== 'undefined') {
        versionEl.textContent = APP_CONFIG.version;
    }
}

function initMobileMenu() {
    const menuBtn = document.getElementById('mobile-menu-btn');
    const mobileMenu = document.getElementById('mobile-menu');
    const menuIcon = document.getElementById('mobile-menu-icon');

    if (menuBtn && mobileMenu) {
        menuBtn.addEventListener('click', () => {
            mobileMenu.classList.toggle('hidden');
            if (menuIcon) {
                menuIcon.className = mobileMenu.classList.contains('hidden') ? "fa-solid fa-bars" : "fa-solid fa-xmark";
            }
        });
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        updateVersionTag();
        initMobileMenu();
    });
} else {
    updateVersionTag();
    initMobileMenu();
}
