/**
 * CHS ClassPass Phone & Pass Tracking
 * Configuration & Firebase Central Module
 *
 * MULTI-CLASSROOM SETUP
 * Each classroom is its own entry in ROOMS below, with its own Firebase
 * database instance (so rooms are fully isolated from each other) and its
 * own kiosk login. Which room a page uses is picked with a URL parameter:
 *   index.html?room=176      (kiosk)
 *   teacher.html?room=176    (dashboard)
 *   roster.html?room=176     (roster)
 * Bookmark each classroom's three URLs for that teacher. No ?room= at all
 * falls back to DEFAULT_ROOM below, so existing bookmarks from before this
 * setup existed keep working without changes.
 *
 * TO ADD A NEW CLASSROOM:
 *   1. Firebase Console → Realtime Database → create a new database
 *      instance for the room (Add Database). Publish database.rules.json
 *      to it (same file, no changes needed).
 *   2. Authentication → add a new email/password user for that room's
 *      kiosk (e.g. classpass-room203@chelanschools.net).
 *   3. Have the teacher sign into teacher.html once, grab their UID from
 *      Authentication → Users, add it to that new instance's
 *      allowed_teachers. Do the same for the kiosk account's UID in
 *      allowed_kiosks.
 *   4. Copy one of the blocks below, give it a new key (e.g. "203"),
 *      update department/pocketLayout/kioskAuth/firebaseConfig.databaseURL
 *      for the new room. apiKey/authDomain/projectId/storageBucket/
 *      messagingSenderId/appId stay the same as any other room IF it's a
 *      new database instance in this SAME Firebase project — only
 *      databaseURL changes in that case. If it's a fully separate Firebase
 *      project instead, copy the whole firebaseConfig block from that
 *      project's settings.
 *   5. Push. Send the teacher their three ?room= URLs.
 */

// STAGING COPY: defaults to "dev" instead of "176" specifically so that
// forgetting ?room= while testing here can never silently read/write real
// production data. The production config.js (outside /staging/) keeps
// DEFAULT_ROOM as "176" — this difference is intentional and should NOT be
// copied over when promoting tested files out of /staging/.
const DEFAULT_ROOM = "dev";

// PASS_TYPES is the one place a new kind of pass gets defined — its display
// label, icon, color, which database node it lives in, and its log code.
// Adding Goat Room or Library Pass later means adding an entry HERE and
// listing it in a room's enabledPassTypes below — nothing else in this file,
// and nothing in kiosk.js/teacher.js/teacher.html, needs to change. Rules
// don't need touching either: database.rules.json uses a $passType wildcard
// that covers whatever key is used here automatically.
export const PASS_TYPES = {
  bathroom: {
    label: "Bathroom Pass",
    icon: "🚻",
    color: "red",       // must match a family with real CSS in styles.css
    logCode: "BP",
    maxConcurrent: 1    // null = unlimited; a number caps global concurrent count (still overridable via Manual Pass Override)
  },
  hall: {
    label: "Hall Pass",
    icon: "🎟️",
    color: "indigo",
    logCode: "HP",
    maxConcurrent: null
  },
  goatroom: {
    label: "Goat Room Pass",
    icon: "🐐",
    color: "amber",
    logCode: "GR",
    maxConcurrent: null
  }
};

const ROOMS = {
  "176": {
    schoolName: "Chelan High",
    logoUrl: "https://assets-rst7.rschooltoday.com/rst7files/uploads/sites/396/2025/08/12090756/Logo-Header.png",
    department: "ROOM 176",
    pocketLayout: {
      rows: 5,                          // Rows in the phone pocket grid
      cols: 7                           // Columns in the phone pocket grid
    },
    enablePhoneStorage: true,
    enabledPassTypes: ["bathroom", "hall"],
    // Dedicated permanent sign-in used by this room's kiosk (not a real
    // mailbox). This is public the same way everything else in this file
    // is public — access control comes from database.rules.json on this
    // room's own database instance, not from hiding this.
    kioskAuth: {
      email: "classpass@chelanschools.net",
      password: "Goatkiosk2026!"
    },
    firebaseConfig: {
      apiKey: "AIzaSyDOqjLMzMydaR31WWUA35sr1FrNLfHPxuI",
      authDomain: "chelan-classroom-pass-a811e.firebaseapp.com",
      databaseURL: "https://chelan-classroom-pass-a811e-default-rtdb.firebaseio.com",
      projectId: "chelan-classroom-pass-a811e",
      storageBucket: "chelan-classroom-pass-a811e.firebasestorage.app",
      messagingSenderId: "645480807479",
      appId: "1:645480807479:web:d280d4ef38e8754a9953b2"
    }
  },

  "150": {
    schoolName: "Chelan High",
    logoUrl: "https://assets-rst7.rschooltoday.com/rst7files/uploads/sites/396/2025/08/12090756/Logo-Header.png",
    department: "ROOM 150",
    pocketLayout: {
      rows: 5,                          // Rows in the phone pocket grid
      cols: 7                           // Columns in the phone pocket grid
    },
    enablePhoneStorage: true,
    enabledPassTypes: ["bathroom", "hall"],
    kioskAuth: {
      email: "classpass-room150@chelanschools.net",
      password: "Michael2026!"
    },
    firebaseConfig: {
      // Same project as room 176 — only databaseURL differs.
      apiKey: "AIzaSyDOqjLMzMydaR31WWUA35sr1FrNLfHPxuI",
      authDomain: "chelan-classroom-pass-a811e.firebaseapp.com",
      databaseURL: "https://chelan-classroom-pass-150.firebaseio.com",
      projectId: "chelan-classroom-pass-a811e",
      storageBucket: "chelan-classroom-pass-a811e.firebasestorage.app",
      messagingSenderId: "645480807479",
      appId: "1:645480807479:web:d280d4ef38e8754a9953b2"
    }
  },

  "dev": {
    schoolName: "ClassPass Dev",
    logoUrl: "", // intentionally empty — dev shouldn't depend on school-hosted assets at all
    department: "DEV / STAGING",
    pocketLayout: {
      rows: 5,
      cols: 7
    },
    enablePhoneStorage: true,
    enabledPassTypes: ["bathroom", "hall"],
    kioskAuth: {
      email: "jm-classpass-dev@jdoggg.com",
      password: "Classpassdev2026!"
    },
    firebaseConfig: {
      // Same project as every other room — only databaseURL differs.
      apiKey: "AIzaSyDOqjLMzMydaR31WWUA35sr1FrNLfHPxuI",
      authDomain: "chelan-classroom-pass-a811e.firebaseapp.com",
      databaseURL: "https://jm-classpass-dev.firebaseio.com",
      projectId: "chelan-classroom-pass-a811e",
      storageBucket: "chelan-classroom-pass-a811e.firebasestorage.app",
      messagingSenderId: "645480807479",
      appId: "1:645480807479:web:d280d4ef38e8754a9953b2"
    }
  },

  "M211": {
    schoolName: "Morgen Owings Elementary",
    logoUrl: "", // M.O.E.'s own logo, once you have one to use
    department: "Room 211",
    enablePhoneStorage: false, // no phone check-in at the elementary level
    enabledPassTypes: ["bathroom", "hall", "goatroom"],
    kioskAuth: {
      email: "classpass@jdoggg.com",
      password: "ClassPass2026!"
    },
    // This is a GENUINELY SEPARATE Firebase project, not just a new
    // database instance — every single field below differs from Chelan
    // HS's, not just databaseURL. Pull all of these from that new
    // project's own Settings → General → Your apps → SDK config snippet.
    firebaseConfig: {
      apiKey: "AIzaSyBgIFhw50ofWS78TyDKo8YVVsXlbfSWSZ0",
      authDomain: "moe-classpass.firebaseapp.com",
      databaseURL: "https://moe-classpass-default-rtdb.firebaseio.com",
      projectId: "moe-classpass",
      storageBucket: "moe-classpass.firebasestorage.app",
      messagingSenderId: "776663685229",
      appId: "1:776663685229:web:c4fbf94add5818dd98c764"
    }
  }

  // Add new classrooms here, e.g.:
  // "203": {
  //   schoolName: "Chelan High",
  //   logoUrl: "https://assets-rst7.rschooltoday.com/rst7files/uploads/sites/396/2025/08/12090756/Logo-Header.png", // or "" to show no logo
  //   department: "ROOM 203",
  //   pocketLayout: { rows: 4, cols: 8 },
  //   enablePhoneStorage: true,
  //   enabledPassTypes: ["bathroom", "hall"], // add "goatroom" etc. once defined in PASS_TYPES above
  //   kioskAuth: { email: "classpass-room203@chelanschools.net", password: "..." },
  //   firebaseConfig: {
  //     apiKey: "...",             // same as room 176 if same Firebase project
  //     authDomain: "...",         // same as room 176 if same Firebase project
  //     databaseURL: "https://chelan-room203-rtdb.firebaseio.com", // the new instance
  //     projectId: "...",          // same as room 176 if same Firebase project
  //     storageBucket: "...",      // same as room 176 if same Firebase project
  //     messagingSenderId: "...",  // same as room 176 if same Firebase project
  //     appId: "..."               // same as room 176 if same Firebase project
  //   }
  // }
};

const requestedRoom = new URLSearchParams(window.location.search).get('room') || DEFAULT_ROOM;
const roomConfig = ROOMS[requestedRoom];

if (!roomConfig) {
  // Fail loudly and clearly rather than silently falling back to the
  // wrong classroom's data — a mistyped ?room= should never let someone
  // land on the wrong roster by accident.
  document.body.innerHTML = `<div style="font-family:sans-serif;padding:40px;text-align:center;color:#7f1d1d;">
    <h1 style="font-size:20px;">Unknown classroom "${requestedRoom}"</h1>
    <p>Check the room number in the URL, or ask your admin.</p>
  </div>`;
  throw new Error(`Unknown room "${requestedRoom}" — check ROOMS in config.js`);
}

export const APP_CONFIG = {
  version: "***v3.1.2***",
  ...roomConfig
};

// Which room this page loaded as (the actual ?room= value, or DEFAULT_ROOM if
// none was given). Used by teacher.js/roster.js to keep the top nav links
// pointed at the SAME room when switching between dashboard/roster/kiosk —
// otherwise clicking between them silently drops back to the default room.
APP_CONFIG.roomKey = requestedRoom;

// Total selectable pockets — always derived from pocketLayout above, so this
// number can never drift out of sync with the grid the way it did before
// (config used to say 30 while the kiosk grid actually rendered 35).
// To change pocket count, edit pocketLayout.rows / pocketLayout.cols only.
// Rooms with enablePhoneStorage: false (like M.O.E.) can skip pocketLayout
// entirely — defaults to 1x1 here so nothing crashes; it's never rendered
// anyway, since the pocket grid only shows in phone mode, which those rooms
// never enter.
if (!APP_CONFIG.pocketLayout) {
  APP_CONFIG.pocketLayout = { rows: 1, cols: 1 };
}
APP_CONFIG.pocketsAvailable = APP_CONFIG.pocketLayout.rows * APP_CONFIG.pocketLayout.cols;

/**
 * Shared Helper Functions
 */

// Formats seconds into "Xm Ys" or "Xs"
export function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || isNaN(seconds)) return "--";
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins > 0) {
    return `${mins}m ${secs}s`;
  }
  return `${secs}s`;
}

// Formats timestamp into "10:13 AM"
export function formatTime(dateObj = new Date()) {
  return dateObj.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true
  });
}

// Formats timestamp into "8/10/2026"
export function formatDate(dateObj = new Date()) {
  return dateObj.toLocaleDateString("en-US");
}

// Escapes untrusted text (student names, guest-request names, etc.) so it can be
// safely inserted into innerHTML — as text content OR inside a quoted attribute
// like value="..." or title="...". Use this anywhere a name/ID that a person
// typed is being template-strung into HTML. Do NOT use for CSV building — CSV
// quoting rules are different (see escapeAttr in teacher.js).
export function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Applies this room's school name / logo everywhere those used to be
// hardcoded directly in the HTML. Call once, early, on every page.
// Looks for elements marked with a data-brand attribute rather than
// specific IDs, so it works identically across index.html/teacher.html/
// roster.html without needing three separate copies of this logic:
//   data-brand="school-name"  -> filled with APP_CONFIG.schoolName
//   data-brand="logo"         -> src set to APP_CONFIG.logoUrl, or
//                                 hidden entirely if logoUrl is empty
//   data-brand="footer"       -> filled with a standard footer line
// Also updates the favicon and (optionally) the page title.
export function applyBranding(titleSuffix) {
  const schoolName = APP_CONFIG.schoolName || "ClassPass";
  const logoUrl = APP_CONFIG.logoUrl || "";

  document.querySelectorAll('[data-brand="school-name"]').forEach(el => {
    el.textContent = schoolName;
  });

  document.querySelectorAll('[data-brand="logo"]').forEach(el => {
    if (logoUrl) {
      el.src = logoUrl;
      el.style.display = "";
    } else {
      el.style.display = "none";
    }
  });

  const favicon = document.querySelector('link[rel="icon"]');
  if (favicon && logoUrl) {
    favicon.href = logoUrl;
  }

  document.querySelectorAll('[data-brand="footer"]').forEach(el => {
    el.textContent = `${schoolName} Classroom Pass System \u2022 Powered by Firebase`;
  });

  if (titleSuffix) {
    document.title = `${schoolName} \u2014 ClassPass ${titleSuffix}`;
  }
}
