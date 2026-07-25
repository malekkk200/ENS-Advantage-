/* ═══════════════════════════════════════════════════════════════
   GRADE CALCULATOR
═══════════════════════════════════════════════════════════════ */
import { $ } from './dom.js';
import { State } from './state.js';
import { Curriculum } from './curriculum.js';
import { MemeSystem } from './memeSystem.js';

/* ─────────────────────────────────────────────────────────────
   GRADE CALCULATOR
───────────────────────────────────────────────────────────── */
export const Calc = {
  switchSem(sem) {
    State.calcActiveSem = sem;
    $('calc-tab-1').classList.toggle('active', sem === 1);
    $('calc-tab-2').classList.toggle('active', sem === 2);
    this.renderSem(sem);
  },

  renderSem(sem) {
    const data = Curriculum.CALC_DATA[sem];
    let html = '';

    data.forEach((ue, ueIdx) => {
      html += `
      <div class="calc-container">
        <div class="calc-ue-header">
          <span>${ue.code}</span>
          <span class="calc-ue-avg-badge" id="calc-ue-badge-${sem}-${ueIdx}">&mdash; / 20</span>
        </div>
        <table class="calc-table">
          <thead>
            <tr>
              <th style="width:40%">Module</th>
              <th style="width:8%;text-align:center;">Coef</th>
              <th style="width:18%;text-align:center;">TD <span style="font-weight:400;opacity:.65;text-transform:none;letter-spacing:0;">(33%)</span></th>
              <th style="width:18%;text-align:center;">Exam <span style="font-weight:400;opacity:.65;text-transform:none;letter-spacing:0;">(67%)</span></th>
              <th style="width:16%;text-align:center;">Moyenne</th>
            </tr>
          </thead>
          <tbody>`;

      ue.modules.forEach((mod, modIdx) => {
        const uid = `${sem}-${ueIdx}-${modIdx}`;
        const tdStyle = mod.rtl ? ' style="direction:rtl;font-family:\'Cairo\',sans-serif;"' : '';
        html += `
            <tr>
              <td${tdStyle}>${mod.name}</td>
              <td style="text-align:center;font-weight:600;color:var(--slate-500);">${mod.coef}</td>
              <td style="text-align:center;">
                <input class="calc-input" type="number" id="calc-td-${uid}" data-action="calc-input" data-sem="${sem}"
                  min="0" max="20" step="0.25" placeholder="—" />
              </td>
              <td style="text-align:center;">
                <input class="calc-input" type="number" id="calc-exam-${uid}" data-action="calc-input" data-sem="${sem}"
                  min="0" max="20" step="0.25" placeholder="—" />
              </td>
              <td style="text-align:center;">
                <span class="calc-avg-cell avg-empty" id="calc-avg-${uid}">&mdash;</span>
                <div class="calc-status-tag" id="calc-status-${uid}"></div>
              </td>
            </tr>`;
      });

      html += `
          </tbody>
        </table>
        <div class="calc-ue-note" id="calc-ue-note-${sem}-${ueIdx}"></div>
      </div>`;
    });

    html += `
    <div class="calc-result-card">
      <div class="calc-res-left">
        <div class="calc-res-label">Moyenne Semestre ${sem}</div>
        <div class="calc-res-value" id="calc-sem-val-${sem}">&mdash;</div>
        <div class="calc-res-mention" id="calc-sem-mention-${sem}"></div>
      </div>
      <div class="calc-ue-breakdown">
        <div class="calc-ue-item">
          <div class="calc-ue-item-label">UE Transversale</div>
          <div class="calc-ue-item-val" id="calc-ue-val-${sem}-0">&mdash;</div>
        </div>
        <div class="calc-ue-item">
          <div class="calc-ue-item-label">UE Disciplinaire</div>
          <div class="calc-ue-item-val" id="calc-ue-val-${sem}-1">&mdash;</div>
        </div>
      </div>
    </div>
    <div class="calc-official-note" id="calc-official-note-${sem}"></div>
    <div class="meme-box" id="meme-box-${sem}"></div>`;

    const bodyEl = $('calc-body');
    bodyEl.innerHTML = html;
    // Delegated input listener — avoids inline oninput="" string interpolation.
    // Also clamps TD/Exam values to [0, 20] immediately as the user types,
    // enforcing the mathematical rule that no grade can exceed 20.
    bodyEl.addEventListener('input', (e) => {
      const input = e.target.closest('[data-action="calc-input"]');
      if (!input) return;
      const raw = parseFloat(input.value);
      if (!isNaN(raw)) {
        if (raw > 20) input.value = '20';
        else if (raw < 0) input.value = '0';
      }
      // Coalesce rapid keystrokes into a single recalc per animation frame.
      // Previously recalc() ran synchronously on every keystroke, which
      // competes with the meme GIF/video for main-thread time and made
      // playback look laggy while grades were being typed.
      this._scheduleRecalc(parseInt(input.dataset.sem, 10));
    });
  },

  _pendingSems: new Set(),
  _recalcRAF: null,
  _scheduleRecalc(sem) {
    this._pendingSems.add(sem);
    if (this._recalcRAF) return;
    this._recalcRAF = requestAnimationFrame(() => {
      this._recalcRAF = null;
      const sems = [...this._pendingSems];
      this._pendingSems.clear();
      sems.forEach((s) => this.recalc(s));
    });
  },

  recalc(sem) {
    const data = Curriculum.CALC_DATA[sem];
    let semWeighted = 0, semCoefUsed = 0, semIsPartial = false;
    // Collected across all UEs for this semester, to build the note below —
    // module names bucketed by the official catch-up rule that applies to them.
    const mandatoryRetake = []; // avg < 5 — "نقطة إقصائية", catch-up compulsory
    const optionalRetake  = []; // 5 <= avg < 10 — catch-up optional
    const weakUEs = [];         // UE avg < 8 — must catch-up to raise above 8
    let filledModulesCount = 0;

    data.forEach((ue, ueIdx) => {
      let ueWeighted = 0, ueCoefFilled = 0;
      const ueTotalCoef = ue.modules.reduce((s, m) => s + m.coef, 0);

      ue.modules.forEach((mod, modIdx) => {
        const uid = `${sem}-${ueIdx}-${modIdx}`;
        const tdEl = $(`calc-td-${uid}`);
        const examEl = $(`calc-exam-${uid}`);
        const avgEl = $(`calc-avg-${uid}`);
        const statusEl = $(`calc-status-${uid}`);
        if (!tdEl || !examEl || !avgEl) return;

        const tdStr = tdEl.value.trim(), examStr = examEl.value.trim();
        if (tdStr !== '' && examStr !== '') {
          const td = Math.min(20, Math.max(0, parseFloat(tdStr) || 0));
          const exam = Math.min(20, Math.max(0, parseFloat(examStr) || 0));
          const avg = (td * 0.33) + (exam * 0.67);
          const r = Math.round(avg * 100) / 100;
          avgEl.textContent = r.toFixed(2);
          // Thresholds per the official catch-up (استدراك) notice:
          // >=10 pass (no retake allowed), 5-10 optional retake, <5 mandatory.
          // (Distinct from the UE-level <8 rule handled separately below.)
          avgEl.className = 'calc-avg-cell ' + (r >= 10 ? 'avg-good' : r >= 5 ? 'avg-warn' : 'avg-bad');
          if (statusEl) {
            if (r < 5) {
              statusEl.textContent = 'استدراك إجباري';
              statusEl.className = 'calc-status-tag tag-bad';
              mandatoryRetake.push(mod.name);
            } else if (r < 10) {
              statusEl.textContent = 'استدراك اختياري';
              statusEl.className = 'calc-status-tag tag-warn';
              optionalRetake.push(mod.name);
            } else {
              statusEl.textContent = 'ناجح ✓';
              statusEl.className = 'calc-status-tag tag-good';
            }
          }
          ueWeighted += avg * mod.coef;
          ueCoefFilled += mod.coef;
          filledModulesCount++;
        } else {
          avgEl.textContent = '\u2014';
          avgEl.className = 'calc-avg-cell avg-empty';
          if (statusEl) { statusEl.textContent = ''; statusEl.className = 'calc-status-tag'; }
        }
      });

      const badgeEl = $(`calc-ue-badge-${sem}-${ueIdx}`);
      const ueValEl = $(`calc-ue-val-${sem}-${ueIdx}`);
      const ueNoteEl = $(`calc-ue-note-${sem}-${ueIdx}`);
      if (ueCoefFilled > 0) {
        const ueAvg = ueWeighted / ueCoefFilled;
        const ueR = Math.round(ueAvg * 100) / 100;
        const partial = ueCoefFilled < ueTotalCoef;
        const suffix = partial ? ' *' : '';
        if (badgeEl) {
          badgeEl.textContent = ueR.toFixed(2) + ' / 20' + suffix;
          badgeEl.classList.toggle('badge-weak', ueR < 8);
        }
        if (ueValEl) ueValEl.textContent = ueR.toFixed(2) + suffix;
        if (ueNoteEl) {
          if (ueR < 8) {
            ueNoteEl.textContent = `⚠️ معدل الوحدة أقل من 8 — يجب اجتياز الاستدراك لرفعه`;
            ueNoteEl.className = 'calc-ue-note note-bad';
            weakUEs.push(ue.code);
          } else {
            ueNoteEl.textContent = '';
            ueNoteEl.className = 'calc-ue-note';
          }
        }
        semWeighted += ueAvg * ue.ueCoef;
        semCoefUsed += ue.ueCoef;
        if (partial) semIsPartial = true;
      } else {
        if (badgeEl) { badgeEl.textContent = '\u2014 / 20'; badgeEl.classList.remove('badge-weak'); }
        if (ueValEl) ueValEl.textContent = '\u2014';
        if (ueNoteEl) { ueNoteEl.textContent = ''; ueNoteEl.className = 'calc-ue-note'; }
        semIsPartial = true;
      }
    });

    const semValEl = $(`calc-sem-val-${sem}`);
    const semMentionEl = $(`calc-sem-mention-${sem}`);
    const officialNoteEl = $(`calc-official-note-${sem}`);
    if (!semValEl) return;

    // This is the answer to "what do I need to succeed, and where did I
    // fail" — built entirely from the grades this student just entered,
    // not a copy of the official notice. Shows as soon as at least one
    // module has been calculated, and always states a clear verdict
    // (including the all-clear case), not just when there's a problem.
    if (officialNoteEl) {
      if (filledModulesCount === 0) {
        officialNoteEl.innerHTML = '';
        officialNoteEl.className = 'calc-official-note';
      } else if (mandatoryRetake.length === 0 && optionalRetake.length === 0 && weakUEs.length === 0) {
        officialNoteEl.innerHTML = `<div class="note-line note-good">✅ <strong>ناجح مباشرة</strong> في جميع المقاييس المُدخلة — لا حاجة لأي استدراك.</div>`;
        officialNoteEl.className = 'calc-official-note has-notes state-good';
      } else {
        let html = `<div class="note-heading">🎯 ماذا تحتاج للنجاح:</div>`;
        if (mandatoryRetake.length) {
          html += `<div class="note-line note-bad">🔴 <strong>يجب عليك اجتياز الاستدراك</strong> في: ${mandatoryRetake.join('، ')} — معدلك فيها أقل من 5 (نقطة إقصائية، نجاح بدين).</div>`;
        }
        if (optionalRetake.length) {
          html += `<div class="note-line note-warn">🟡 <strong>يمكنك تحسين معدلك</strong> باستدراك اختياري في: ${optionalRetake.join('، ')} (معدلك بين 5 و10).</div>`;
        }
        if (weakUEs.length) {
          html += `<div class="note-line note-bad">⚠️ معدل الوحدة أقل من 8 في: ${weakUEs.join('، ')} — الاستدراك مطلوب لرفعه فوق 8.</div>`;
        }
        officialNoteEl.innerHTML = html;
        officialNoteEl.className = 'calc-official-note has-notes state-bad';
      }
    }

    if (semCoefUsed > 0) {
      const semAvg = semWeighted / semCoefUsed;
      const semR = Math.round(semAvg * 100) / 100;
      semValEl.textContent = semR.toFixed(2) + ' / 20';
      semValEl.style.opacity = semIsPartial ? '0.75' : '1';

      if (semIsPartial) {
        semMentionEl.textContent = '(\u062d\u0633\u0627\u0628 \u062c\u0632\u0626\u064a \u2014 \u0623\u062f\u062e\u0644 \u062c\u0645\u064a\u0639 \u0627\u0644\u0639\u0644\u0627\u0645\u0627\u062a)';
      } else if (mandatoryRetake.length > 0) {
        // Official notice: a module average below 5 means the semester
        // is NOT a clean pass yet — "نجاح بدين" (conditional), not "راسب"
        // outright, since catch-up can still resolve it.
        semMentionEl.textContent = '🟡 نجاح بدين — قرار أولي';
      } else {
        const mentions = [
          [16, '\ud83c\udfc6 Tr\xe8s Bien'],
          [14, '\u2728 Bien'],
          [12, '\ud83d\udc4d Assez Bien'],
          [10, '\u2713 Passable'],
          [0, '\u26a0\ufe0f Insuffisant \u2014 \u0641\u064a \u062e\u0637\u0631']
        ];
        semMentionEl.textContent = mentions.find(([t]) => semR >= t)[1];
      }
      // Show the meme for the completed (or partial) GPA bracket.
      // No GPA value is sent anywhere — memeSystem.show() resolves the
      // category client-side and plays the matching meme locally.
      MemeSystem.show(semR, sem);
    } else {
      semValEl.textContent = '\u2014';
      semValEl.style.opacity = '1';
      semMentionEl.textContent = '';
      // No grades entered — hide the meme box cleanly
      MemeSystem.hide(sem);
    }
  },

  init() {
    if ($('calc-body')) this.renderSem(1);
  }
};

