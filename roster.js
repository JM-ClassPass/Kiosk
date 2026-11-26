import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getDatabase, ref, onValue, set, remove, get, update } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";
import { APP_CONFIG, escapeHtml, applyBranding } from './config.js';

// ==========================================
// 1. FIREBASE INITIALIZATION & AUTH SETUP
// ==========================================
const app = initializeApp(APP_CONFIG.firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);
const provider = new GoogleAuthProvider();
applyBranding("Roster");

// Room label — was hardcoded as static "ROOM 176" text with no JS behind it
// at all, so it never updated per-room. Same fix as teacher.js.
const roomLabelEl = document.getElementById('room-label');
if (roomLabelEl) roomLabelEl.textContent = `TEACHER STATION • ${APP_CONFIG.department}`;

// Live clock — roster.html has the same placeholder teacher.html had before
// it was wired up. Same fix, ported over.
const liveClockEl = document.getElementById('live-clock');
if (liveClockEl) {
  const tickClock = () => {
    liveClockEl.textContent = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  };
  tickClock();
  setInterval(tickClock, 1000);
}

// Same fixup as teacher.js — keep every nav link on this page pointed at
// whatever room is currently loaded, instead of silently dropping back to
// the default room when switching between dashboard/roster/kiosk.
document.querySelectorAll('a[href]').forEach(a => {
    const href = a.getAttribute('href');
    if (/^(index|teacher|roster)\.html$/.test(href)) {
        a.setAttribute('href', `${href}?room=${encodeURIComponent(APP_CONFIG.roomKey)}`);
    }
});

// Header Profile Elements
const userProfile = document.getElementById("user-profile");
const userEmailSpan = document.getElementById("user-email");
const logoutBtn = document.getElementById("logout-btn");

// Login Overlay Elements
const loginOverlay = document.getElementById("login-overlay");
const loginBtn = document.getElementById("login-btn");
const loginError = document.getElementById("login-error");

// ==========================================
// 2. AUTH GUARD & ALLOWLIST VERIFICATION
// ==========================================
onAuthStateChanged(auth, async (user) => {
  if (user) {
    if (loginError) loginError.textContent = "Verifying permissions...";

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

      console.log(`Teacher authorized on Roster: ${user.email}`);
    } else {
      if (loginError) loginError.textContent = "Access Denied: this account isn't on the approved teacher list. Ask an admin to add your UID.";
      if (userProfile) userProfile.classList.add("hidden");
      signOut(auth);
    }
  } else {
    if (loginOverlay) loginOverlay.classList.remove("hidden");
    if (userProfile) userProfile.classList.add("hidden");
    // DELETE OR COMMENT OUT THIS LINE BELOW:
    // if (loginError) loginError.textContent = "";
  }
});

if (loginBtn) {
  loginBtn.addEventListener("click", () => signInWithPopup(auth, provider));
}

if (logoutBtn) {
  logoutBtn.addEventListener("click", () => signOut(auth));
}

// ==========================================
// 3. STATE VARIABLES
// ==========================================
let rosterData = [];
let sortCol = 'lastName';
let sortDesc = false;
let searchQuery = '';
let isEditAllMode = false;
let editingRows = new Set(); 
let selectedRows = new Set(); // Tracks rows checked for bulk deletion
let currentFilteredRoster = []; // Keeps track of what's currently visible
let csvFileToImport = null;
let groupFilterValue = ''; // '' = all groups

// Optional roster groups (e.g. two class blocks). Only rooms that define
// rosterGroups in config.js get any of the group UI below; every other room
// sees the roster exactly as before.
const ROSTER_GROUPS = APP_CONFIG.rosterGroups || [];
const groupsOn = ROSTER_GROUPS.length > 0;
const tableColCount = groupsOn ? 6 : 5;
const groupOptionsHtml = (selected) =>
  `<option value="">No group</option>` + ROSTER_GROUPS.map(g => `<option value="${escapeHtml(g)}"${g === selected ? ' selected' : ''}>${escapeHtml(g)}</option>`).join('');

// Matches a typed/CSV group value to a configured group: exact (any case),
// or just the number ("1" matches "Group 1"). Returns '' if nothing matches.
function matchGroup(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return '';
  const hit = ROSTER_GROUPS.find(g => g.toLowerCase() === v || g.toLowerCase() === `group ${v}`);
  return hit || '';
}

// ==========================================
// 4. UI ELEMENT REFERENCES
// ==========================================
const clockEl = document.getElementById('roster-clock');
const tableBody = document.getElementById('roster-table-body');
const countEl = document.getElementById('roster-count');
const searchInput = document.getElementById('search-input');
const btnEditAll = document.getElementById('btn-edit-all');
const btnSaveAll = document.getElementById('btn-save-all');
const btnCancelEdit = document.getElementById('btn-cancel-edit');
const btnExport = document.getElementById('btn-export-roster');
const btnBulkDelete = document.getElementById('btn-bulk-delete');
const bulkDeleteCount = document.getElementById('bulk-delete-count');
const cbSelectAll = document.getElementById('cb-select-all');
const formAddStudent = document.getElementById('form-add-student');

const dropZone = document.getElementById('drop-zone');
const dropZoneText = document.getElementById('drop-zone-text');
const csvInput = document.getElementById('csv-file-input');
const btnBrowse = document.getElementById('btn-browse-file');
const btnProcessImport = document.getElementById('btn-process-import');

// Build the group UI once, up front (before any listeners that look for
// .sort-header or the bulk buttons are attached).
let groupFilterEl = null;
let bulkGroupWrap = null;
let bulkGroupSelect = null;
if (groupsOn) {
  // Column header, just before "Actions"
  const headRow = document.querySelector('#roster-table-body')?.closest('table')?.querySelector('thead tr');
  if (headRow) {
    const th = document.createElement('th');
    th.setAttribute('data-sort', 'group');
    th.className = 'sort-header py-3 px-3 cursor-pointer select-none hover:text-[#0B4F2C]';
    th.innerHTML = 'Group <span id="sort-icon-group" class="ml-0.5 text-slate-400">&uarr;&darr;</span>';
    headRow.insertBefore(th, headRow.lastElementChild);
  }

  // Filter dropdown, next to the search box
  groupFilterEl = document.createElement('select');
  groupFilterEl.id = 'group-filter';
  groupFilterEl.className = 'rg-select';
  groupFilterEl.innerHTML = `<option value="">All groups</option>` + ROSTER_GROUPS.map(g => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join('');
  groupFilterEl.addEventListener('change', () => { groupFilterValue = groupFilterEl.value; renderTable(); });

  // "Set group" for whatever rows are checked
  bulkGroupWrap = document.createElement('div');
  bulkGroupWrap.className = 'rg-bulk hidden';
  bulkGroupSelect = document.createElement('select');
  bulkGroupSelect.className = 'rg-select';
  bulkGroupSelect.innerHTML = groupOptionsHtml('');
  const bulkGroupBtn = document.createElement('button');
  bulkGroupBtn.type = 'button';
  bulkGroupBtn.className = 'rg-bulk-btn';
  bulkGroupBtn.textContent = 'Set group';
  bulkGroupBtn.addEventListener('click', async () => {
    if (selectedRows.size === 0) return;
    const updates = {};
    selectedRows.forEach(id => { updates[`classroom_roster/${id}/group`] = bulkGroupSelect.value || null; });
    try {
      await update(ref(db), updates);
      selectedRows.clear();
      renderTable();
    } catch (err) {
      alert("Error setting group: " + err.message);
    }
  });
  bulkGroupWrap.appendChild(bulkGroupSelect);
  bulkGroupWrap.appendChild(bulkGroupBtn);

  const anchor = btnBulkDelete || btnEditAll;
  if (anchor && anchor.parentNode) {
    anchor.parentNode.insertBefore(groupFilterEl, anchor);
    anchor.parentNode.insertBefore(bulkGroupWrap, anchor);
  }

  // Group dropdown on the Quick Add form
  if (formAddStudent) {
    const wrap = document.createElement('div');
    wrap.innerHTML = `<label class="block text-[10px] font-bold text-slate-500 uppercase mb-1">Group</label><select id="input-group" class="rg-select rg-select-full">${groupOptionsHtml('')}</select>`;
    formAddStudent.insertBefore(wrap, formAddStudent.querySelector('button[type="submit"]'));
  }
}

// ==========================================
// 5. CLOCK & INITIALIZATION
// ==========================================
setInterval(() => {
  if (clockEl) {
    clockEl.textContent = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  }
}, 1000);

// Load data in real-time
const rosterRef = ref(db, 'classroom_roster');
onValue(rosterRef, (snapshot) => {
  rosterData = [];
  if (snapshot.exists()) {
    const data = snapshot.val();
    for (const [id, info] of Object.entries(data)) {
      rosterData.push({ id, firstName: info.firstName, lastName: info.lastName, group: info.group || '' });
    }
  }
  
  // Clean up selectedRows in case someone was deleted elsewhere
  const existingIds = new Set(rosterData.map(s => s.id));
  for (let id of selectedRows) {
    if (!existingIds.has(id)) selectedRows.delete(id);
  }
  
  renderTable();
});

// ==========================================
// 6. TABLE RENDERING & LOGIC
// ==========================================
function renderTable() {
  if (!tableBody) return;

  // Filter
  currentFilteredRoster = rosterData.filter(s => 
    (!groupFilterValue || s.group === groupFilterValue) && (
      s.id.toLowerCase().includes(searchQuery) ||
      s.firstName.toLowerCase().includes(searchQuery) ||
      s.lastName.toLowerCase().includes(searchQuery)
    )
  );

  // Sort
  currentFilteredRoster.sort((a, b) => {
    let valA = a[sortCol].toLowerCase();
    let valB = b[sortCol].toLowerCase();
    if (valA < valB) return sortDesc ? 1 : -1;
    if (valA > valB) return sortDesc ? -1 : 1;
    return 0;
  });

  if (countEl) countEl.textContent = currentFilteredRoster.length;
  tableBody.innerHTML = '';

  // Update Select All Checkbox state
  if (cbSelectAll) {
    cbSelectAll.checked = currentFilteredRoster.length > 0 && selectedRows.size === currentFilteredRoster.length;
  }

  updateBulkDeleteUI();

  if (currentFilteredRoster.length === 0) {
    tableBody.innerHTML = `<tr><td colspan="${tableColCount}" class="text-center py-6 text-slate-400">No students found.</td></tr>`;
    return;
  }

  currentFilteredRoster.forEach(student => {
    const tr = document.createElement('tr');
    tr.className = "hover:bg-slate-50/50 transition";
    
    const isEditing = isEditAllMode || editingRows.has(student.id);
    const isSelected = selectedRows.has(student.id);
    
    const safeId = escapeHtml(student.id);
    const safeFirst = escapeHtml(student.firstName);
    const safeLast = escapeHtml(student.lastName);

    const checkboxHtml = `<td class="py-3 px-3 border-t border-slate-100 text-center"><input type="checkbox" class="row-checkbox accent-[#0B4F2C] w-4 h-4 rounded cursor-pointer" data-id="${student.id}" ${isSelected ? 'checked' : ''}></td>`;

    if (isEditing) {
      tr.innerHTML = `
        ${checkboxHtml}
        <td class="py-3 px-3 border-t border-slate-100 font-mono text-slate-500">${safeId}</td>
        <td class="py-3 px-3 border-t border-slate-100"><input type="text" value="${safeFirst}" class="edit-fn w-full border border-slate-300 rounded px-2 py-1.5 text-xs font-bold text-slate-800 focus:border-[#0B4F2C] focus:outline-none" /></td>
        <td class="py-3 px-3 border-t border-slate-100"><input type="text" value="${safeLast}" class="edit-ln w-full border border-slate-300 rounded px-2 py-1.5 text-xs font-bold text-slate-800 focus:border-[#0B4F2C] focus:outline-none" /></td>
        ${groupsOn ? `<td class="py-3 px-3 border-t border-slate-100"><select class="edit-group rg-select">${groupOptionsHtml(student.group)}</select></td>` : ''}
        <td class="py-3 px-3 border-t border-slate-100 text-right">
          <button data-id="${student.id}" class="btn-save inline-flex items-center gap-1.5 text-emerald-700 hover:text-emerald-900 bg-emerald-100 hover:bg-emerald-200 px-3 py-1.5 rounded-lg font-bold transition shadow-sm text-xs">
            <i class="fa-solid fa-check"></i> Save
          </button>
        </td>
      `;
    } else {
      tr.innerHTML = `
        ${checkboxHtml}
        <td class="py-3 px-3 border-t border-slate-100 font-mono text-slate-500">${safeId}</td>
        <td class="py-3 px-3 border-t border-slate-100">${safeFirst}</td>
        <td class="py-3 px-3 border-t border-slate-100">${safeLast}</td>
        ${groupsOn ? `<td class="py-3 px-3 border-t border-slate-100">${student.group ? `<span class="rg-badge">${escapeHtml(student.group)}</span>` : `<span class="text-slate-300">&mdash;</span>`}</td>` : ''}
        <td class="py-3 px-3 border-t border-slate-100 text-right space-x-1.5">
          <button data-id="${student.id}" class="btn-edit text-amber-600 hover:text-amber-700 bg-amber-50 hover:bg-amber-100 px-2.5 py-1.5 rounded-lg shadow-sm transition">
            <i class="fa-solid fa-pen"></i>
          </button>
          <button data-id="${student.id}" class="btn-delete text-rose-500 hover:text-rose-600 bg-rose-50 hover:bg-rose-100 px-2.5 py-1.5 rounded-lg shadow-sm transition">
            <i class="fa-solid fa-trash-can"></i>
          </button>
        </td>
      `;
    }
    tableBody.appendChild(tr);
  });
}

function updateBulkDeleteUI() {
  if (!btnBulkDelete || !bulkDeleteCount) return;

  if (selectedRows.size > 0) {
    btnBulkDelete.classList.remove('hidden');
    btnBulkDelete.classList.add('inline-flex');
    bulkDeleteCount.textContent = selectedRows.size;
    if (bulkGroupWrap) bulkGroupWrap.classList.remove('hidden');
  } else {
    btnBulkDelete.classList.add('hidden');
    btnBulkDelete.classList.remove('inline-flex');
    if (bulkGroupWrap) bulkGroupWrap.classList.add('hidden');
  }
}

// Event Delegation for Table Actions
if (tableBody) {
  tableBody.addEventListener('click', async (e) => {
    const target = e.target.closest('button');
    if (!target) return;

    const id = target.getAttribute('data-id');

    if (target.classList.contains('btn-delete')) {
      if(confirm(`Are you sure you want to remove student ID ${id}?`)) {
        await remove(ref(db, `classroom_roster/${id}`));
        selectedRows.delete(id);
      }
    }

    if (target.classList.contains('btn-edit')) {
      editingRows.add(id);
      renderTable();
    }

    if (target.classList.contains('btn-save')) {
      const tr = target.closest('tr');
      const newFn = tr.querySelector('.edit-fn').value.trim();
      const newLn = tr.querySelector('.edit-ln').value.trim();
      const groupSel = tr.querySelector('.edit-group');
      
      if(newFn && newLn) {
        try {
          await update(ref(db, `classroom_roster/${id}`), { firstName: newFn, lastName: newLn, ...(groupSel ? { group: groupSel.value || null } : {}) });
          editingRows.delete(id);
          renderTable(); 
        } catch (err) {
          alert("Error saving student data. Please check your connection.");
        }
      } else {
        alert("First and Last name cannot be blank.");
      }
    }
  });

  tableBody.addEventListener('change', (e) => {
    if (e.target.classList.contains('row-checkbox')) {
      const id = e.target.getAttribute('data-id');
      if (e.target.checked) {
        selectedRows.add(id);
      } else {
        selectedRows.delete(id);
      }
      renderTable();
    }
  });
}

if (cbSelectAll) {
  cbSelectAll.addEventListener('change', (e) => {
    if (e.target.checked) {
      currentFilteredRoster.forEach(student => selectedRows.add(student.id));
    } else {
      selectedRows.clear();
    }
    renderTable();
  });
}

if (btnBulkDelete) {
  btnBulkDelete.addEventListener('click', async () => {
    if (selectedRows.size === 0) return;
    
    if (confirm(`Are you sure you want to delete ${selectedRows.size} selected students? This cannot be undone.`)) {
      const updates = {};
      selectedRows.forEach(id => {
        updates[`classroom_roster/${id}`] = null;
      });
      
      try {
        await update(ref(db), updates);
        selectedRows.clear();
        renderTable();
      } catch (err) {
        alert("Error deleting students.");
      }
    }
  });
}

// ==========================================
// 7. UI CONTROLS (Search, Sort, Edit Modes)
// ==========================================
if (searchInput) {
  searchInput.addEventListener('input', (e) => {
    searchQuery = e.target.value.toLowerCase();
    renderTable();
  });
}

document.querySelectorAll('.sort-header').forEach(th => {
  th.addEventListener('click', () => {
    const col = th.getAttribute('data-sort');
    if (sortCol === col) {
      sortDesc = !sortDesc;
    } else {
      sortCol = col;
      sortDesc = false;
    }
    
    document.querySelectorAll('[id^="sort-icon-"]').forEach(icon => {
      icon.textContent = '↑↓';
      icon.className = 'ml-0.5 text-slate-400';
    });

    const activeIcon = document.getElementById(`sort-icon-${col}`);
    if (activeIcon) {
      activeIcon.textContent = sortDesc ? '↓' : '↑';
      activeIcon.className = 'ml-0.5 text-[#0B4F2C]';
    }

    renderTable();
  });
});

if (btnEditAll) {
  btnEditAll.addEventListener('click', () => {
    isEditAllMode = true;
    editingRows.clear(); 
    btnEditAll.classList.add('hidden');
    if (btnSaveAll) btnSaveAll.classList.remove('hidden');
    if (btnCancelEdit) btnCancelEdit.classList.remove('hidden');
    renderTable();
  });
}

if (btnSaveAll) {
  btnSaveAll.addEventListener('click', async () => {
    const updates = {};
    
    document.querySelectorAll('#roster-table-body tr').forEach(tr => {
      const saveBtn = tr.querySelector('.btn-save');
      if (saveBtn) {
        const id = saveBtn.getAttribute('data-id');
        const fn = tr.querySelector('.edit-fn').value.trim();
        const ln = tr.querySelector('.edit-ln').value.trim();
        const groupSel = tr.querySelector('.edit-group');
        
        if (fn && ln) {
          updates[`classroom_roster/${id}/firstName`] = fn;
          updates[`classroom_roster/${id}/lastName`] = ln;
          if (groupSel) updates[`classroom_roster/${id}/group`] = groupSel.value || null;
        }
      }
    });
    
    if (Object.keys(updates).length > 0) {
      await update(ref(db), updates);
    }
    
    isEditAllMode = false;
    editingRows.clear();
    btnSaveAll.classList.add('hidden');
    if (btnCancelEdit) btnCancelEdit.classList.add('hidden');
    if (btnEditAll) btnEditAll.classList.remove('hidden');
  });
}

if (btnCancelEdit) {
  btnCancelEdit.addEventListener('click', () => {
    isEditAllMode = false;
    editingRows.clear();
    if (btnSaveAll) btnSaveAll.classList.add('hidden');
    btnCancelEdit.classList.add('hidden');
    if (btnEditAll) btnEditAll.classList.remove('hidden');
    renderTable();
  });
}

// ==========================================
// 8. ADD SINGLE STUDENT
// ==========================================
if (formAddStudent) {
  formAddStudent.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const idInput = document.getElementById('input-id');
    const fnInput = document.getElementById('input-firstname');
    const lnInput = document.getElementById('input-lastname');
    
    const studentId = idInput.value.trim().replace(/[^a-zA-Z0-9]/g, '');
    const firstName = fnInput.value.trim();
    const lastName = lnInput.value.trim();
    const groupInput = document.getElementById('input-group');
    const group = groupInput ? groupInput.value : '';

    if (!studentId || !firstName || !lastName) return;

    try {
      await set(ref(db, `classroom_roster/${studentId}`), { firstName, lastName, ...(group ? { group } : {}) });
      idInput.value = '';
      fnInput.value = '';
      lnInput.value = '';
      idInput.focus();
    } catch (error) {
      alert("Error adding student. Check permissions.");
    }
  });
}

// ==========================================
// 9. CSV IMPORT LOGIC
// ==========================================
if (btnBrowse && csvInput) {
  btnBrowse.addEventListener('click', () => csvInput.click());

  csvInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      csvFileToImport = e.target.files[0];
      if (dropZoneText) {
        dropZoneText.textContent = `Selected: ${csvFileToImport.name}`;
        dropZoneText.classList.add('text-[#0B4F2C]');
      }
    }
  });
}

if (dropZone) {
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('bg-emerald-100/50');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('bg-emerald-100/50');
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('bg-emerald-100/50');
    
    if (e.dataTransfer.files.length > 0) {
      csvFileToImport = e.dataTransfer.files[0];
      if (csvFileToImport.name.endsWith('.csv')) {
        if (dropZoneText) {
          dropZoneText.textContent = `Ready: ${csvFileToImport.name}`;
          dropZoneText.classList.add('text-[#0B4F2C]');
        }
      } else {
        alert("Please upload a valid .csv file.");
        csvFileToImport = null;
      }
    }
  });
}

if (btnProcessImport) {
  btnProcessImport.addEventListener('click', () => {
    if (!csvFileToImport) {
      return alert("Please select or drop a CSV file first.");
    }

    const reader = new FileReader();
    reader.onload = async (e) => {
      const text = e.target.result;
      const lines = text.split('\n').filter(line => line.trim() !== '');
      
      const modeEl = document.querySelector('input[name="import-mode"]:checked');
      const mode = modeEl ? modeEl.value : 'append';
      
      if (mode === 'replace') {
        if(!confirm("WARNING: This will delete your entire existing roster before importing. Continue?")) return;
        await remove(ref(db, 'classroom_roster'));
      }

      let importedCount = 0;
      let unmatchedGroups = 0;

      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split(',').map(p => p.trim());
        if (parts.length >= 3) {
          const sid = parts[0].replace(/[^a-zA-Z0-9]/g, '');
          const fn = parts[1];
          const ln = parts[2];
          
          if (sid && fn && ln) {
            if (groupsOn) {
              // Optional 4th column: group. If a row has none, update only the
              // names so a re-import never wipes groups already assigned.
              const rawGroup = (parts[3] || '').replace(/^"|"$/g, '');
              const group = matchGroup(rawGroup);
              if (rawGroup && !group) unmatchedGroups++;
              await update(ref(db, `classroom_roster/${sid}`), { firstName: fn, lastName: ln, ...(group ? { group } : {}) });
            } else {
              await set(ref(db, `classroom_roster/${sid}`), { firstName: fn, lastName: ln });
            }
            importedCount++;
          }
        }
      }
      
      alert(`Successfully processed ${importedCount} students!` + (unmatchedGroups ? `\n\n${unmatchedGroups} row(s) had a group that didn't match ${ROSTER_GROUPS.join(' / ')} and were left without a group.` : ''));
      csvFileToImport = null;
      if (dropZoneText) {
        dropZoneText.textContent = "Drag & Drop CSV File Here";
        dropZoneText.classList.remove('text-[#0B4F2C]');
      }
      if (csvInput) csvInput.value = ''; 
    };
    
    reader.readAsText(csvFileToImport);
  });
}

// ==========================================
// 10. CSV EXPORT LOGIC
// ==========================================
if (btnExport) {
  btnExport.addEventListener('click', () => {
    if (rosterData.length === 0) return alert("Roster is empty.");
    
    let csvContent = groupsOn ? "ID,First Name,Last Name,Group\n" : "ID,First Name,Last Name\n";
    
    const exportData = [...rosterData].sort((a, b) => a.lastName.localeCompare(b.lastName));
    
    exportData.forEach(s => {
      csvContent += groupsOn
        ? `"${s.id}","${s.firstName}","${s.lastName}","${s.group || ''}"\n`
        : `"${s.id}","${s.firstName}","${s.lastName}"\n`;
    });

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `Chelan_Roster_${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  });
}

// ==========================================
// 11. VERSION TAG & MOBILE MENU
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
