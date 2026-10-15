/* Personal Google Calendar controls for canonical LINE Shift app.
 * No persistent credentials are stored in browser storage.
 * Feature remains unavailable until reviewed server rollout is enabled. */
(function () {
  'use strict';
  const base = 'https://os.senryoyakusha.com';
  let busy = false;

  function message(text) {
    const el = document.getElementById('shiftPersonalCalendarStatus');
    if (el) el.textContent = text;
  }

  async function post(path, payload) {
    if (!window.liff || !liff.isLoggedIn()) throw new Error('LINEでログインしてください。');
    const accessToken = liff.getAccessToken();
    if (!accessToken) throw new Error('LINE認証が切れています。');
    const response = await fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken, ...payload }),
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(response.status === 503 ? 'Googleカレンダー連携は準備中です。' : '接続情報を取得できませんでした。');
    return response.json();
  }

  window.loadShiftPersonalCalendarSettings = async function () {
    if (busy) return;
    try {
      const config = await post('/api/shifts/line/config', {});
      const mode = config?.config?.calendarSyncMode;
      if (['none', 'all', 'common'].includes(mode)) {
        document.getElementById('shiftPersonalCalendarMode').value = mode;
      }
      const status = await post('/api/shifts/line/calendar/status', {});
      const counts=status.counts||{};
      const pending=(counts.pending||0)+(counts.processing||0);
      const failures=(counts.error||0)+(counts.held||0);
      if(!status.connected) {
        message('Googleカレンダーは未接続です。');
      } else if(status.recoveryStaged) {
        message(status.recoveryStageExpired
          ? '復旧用認証の期限が切れました。同じGoogleアカウントで再接続してください。'
          : 'Google再認証は仮保存済みです。旧予定の確認・復旧が終わるまで同期は停止中です。');
      } else if(status.authorization==='reauthorization_required') {
        message('Google認証の期限が切れました。再認証が必要です。');
      } else if(status.reconciliation==='review_required' || (counts.uncertainEffects||0)>0) {
        message('予定の照合が必要です。新しい予定は自動登録されません。');
      } else if(failures>0 || status.lastFailure) {
        message('同期エラーがあります。確認・再試行が必要です。');
      } else if(status.reconciliation!=='verified_clean') {
        message(status.canCreateOnlyPilot === true
          ? 'Google接続済み。選んだシフトを登録できます。'
          : 'Google接続済み。連携開始の確認待ちです。');
      } else {
        message('Google接続済み。未同期 '+pending+'件、失敗0件。');
      }
      const pilotButton = document.getElementById('shiftPersonalCalendarCreateOnlyPilot');
      if (pilotButton) {
        pilotButton.style.display = status.canCreateOnlyPilot === true ? 'block' : 'none';
        const modeLabel = status.syncMode === 'all' ? 'すべてのシフト' : '休み・作業日';
        pilotButton.textContent = status.reconciliation === 'verified_clean'
          ? '選んだシフトの同期を続ける'
          : modeLabel + 'をGoogleカレンダーに反映';
      }
      const issues=document.getElementById('shiftPersonalCalendarIssues');
      if(issues) {
        const textParts=[
          '未同期 '+pending+'件',
          '失敗・停止 '+failures+'件',
          '結果未確認 '+(counts.uncertainEffects||0)+'件',
        ];
        const reasonMap={
          linked_event_missing:'Google上の予定が見つかりません',
          authorization_lost:'Google認証を確認できません',
          refresh_token_revoked:'Googleの再認証が必要です',
          retry_exhausted:'同期の再試行が上限に達しました',
          event_ownership_conflict:'予定の所有者を確認できません',
          connection_changed_during_write:'認証変更中の予定を確認しています',
          uncertain_external_effect:'Googleへの操作結果が未確認です。管理者による確認が必要です',
          effect_settled_reaudit_required:'操作履歴を確認済みです。旧予定の全件照合が必要です',
        };
        for(const issue of (status.issues||[]).slice(0,5)) {
          textParts.push(String(issue.shiftDate||'対象日要確認')+'：'+
            (reasonMap[issue.reason]||'同期結果の確認が必要です'));
        }
        issues.textContent=textParts.join(' ／ ');
      }
    } catch (error) {
      message(error instanceof Error ? error.message : '連携状態を確認できませんでした。');
    }
  };

  window.saveShiftPersonalCalendarMode = async function () {
    if (busy) return;
    const mode = document.getElementById('shiftPersonalCalendarMode')?.value;
    if (!['none', 'all', 'common'].includes(mode)) return;
    busy = true;
    let saved = false;
    try {
      message('同期範囲を保存しています...');
      await post('/api/shifts/line/config', { syncMode: mode });
      saved = true;
      message('同期範囲を保存しました。');
    } catch (error) {
      message(error instanceof Error ? error.message : '保存できませんでした。');
    } finally {
      busy = false;
    }
    // The available registration action follows the saved Staff preference;
    // do not force users to close/reopen Settings after selecting a mode.
    if (saved) await window.loadShiftPersonalCalendarSettings();
  };

  window.connectShiftPersonalCalendar = async function () {
    if (busy) return;
    busy = true;
    try {
      message('Google認証画面を開いています...');
      const data = await post('/api/shifts/line/calendar/connect', {});
      const url = new URL(data.authorizeUrl);
      if (url.origin !== base || url.pathname !== '/api/shifts/line/calendar/authorize') {
        throw new Error('認証URLを確認できませんでした。');
      }
      if (typeof liff.openWindow === 'function') {
        liff.openWindow({ url: url.toString(), external: true });
      } else {
        window.location.assign(url.toString());
      }
    } catch (error) {
      message(error instanceof Error ? error.message : 'Googleの接続を開始できませんでした。');
    } finally {
      busy = false;
    }
  };
  window.previewShiftPersonalCalendar = async function () {
    if (busy) return;
    busy=true;
    try {
      message('旧予定を読み取り専用で照合しています...');
      const result=await post('/api/shifts/line/calendar/reconcile-preview',{});
      const issues=document.getElementById('shiftPersonalCalendarIssues');
      const audit=result.audit;
      if (issues && audit) {
        const lines=[
          '照合対象 '+audit.totalShifts+'件',
          '旧予定の引き継ぎ候補 '+audit.adoptable+'件',
          '要確認 '+audit.reviewRequired+'件',
        ];
        for (const issue of (audit.issues||[]).slice(0,5)) {
          lines.push(String(issue.date)+'：予定の確認が必要です');
        }
        issues.textContent=lines.join(' ／ ');
      }
      message(audit.reviewRequired>0
        ? '旧予定に要確認があります。自動削除・自動再作成は行いません。'
        : '旧予定の読み取り照合が終わりました。同期開始には管理側での確認が必要です。');
    } catch(error) {
      message(error instanceof Error ? error.message : '旧予定の照合ができませんでした。');
    } finally { busy=false; }
  };

  window.previewShiftPersonalCalendarReset = async function () {
    if (busy) return;
    busy = true;
    try {
      message('2026年10月以降の旧予定を読み取り専用で調査しています...');
      const result = await post('/api/shifts/line/calendar/reconcile-preview', { scope: 'reset_2026_10' });
      const inventory = result.inventory;
      if (!inventory || inventory.readOnly !== true || inventory.safeToDelete !== false) {
        throw new Error('調査結果を確認できませんでした。');
      }
      const issues = document.getElementById('shiftPersonalCalendarIssues');
      if (issues) {
        const sourceCounts = inventory.bySource || {};
        const sourceText = Object.entries(sourceCounts)
          .map(([source, count]) => source + ' ' + Number(count) + '件').join('、');
        const lines = [
          '対象期間 2026年10月1日以降',
          'Supabaseシフト ' + inventory.canonicalShifts + '件（' + sourceText + '）',
          '旧シフト予定の削除候補 ' + inventory.oldCandidates + '件',
          '新OS管理予定 ' + inventory.osManaged + '件',
          '要確認 ' + inventory.reviewRequired + '件',
          '削除対象外の予定 ' + inventory.protectedEvents + '件',
          '旧ID未発見 ' + inventory.missingLegacyIds + '件',
          '※旧スプレッドシートにしかない予定IDは未照合。削除候補は全件確定していません',
        ];
        for (const issue of (inventory.issues || []).slice(0, 5)) {
          lines.push(String(issue.date || '対象日不明') + '：確認が必要です');
        }
        issues.textContent = lines.join(' ／ ');
      }
      message('読み取り調査が完了しました。削除・登録・自動同期は一切実行していません。');
    } catch (error) {
      message(error instanceof Error ? error.message : '10月以降の調査ができませんでした。');
    } finally {
      busy = false;
    }
  };

  window.activateShiftPersonalCalendarCreateOnlyPilot = async function () {
    if (busy) return;
    busy = true;
    try {
      message('本人のカレンダーを再確認しています。旧予定は削除しません...');
      let result = await post('/api/shifts/line/calendar/retry', { action: 'activate_create_only' });
      if (!result || result.ok !== true) throw new Error('登録の進行状況を確認できませんでした。');
      let batches = 1;
      while (result.ok && !result.complete && result.pending > 0
        && result.failures === 0 && batches < 40) {
        message('選んだシフトを登録中です。残りの処理 ' + result.pending + '件...');
        const next = await post('/api/shifts/line/calendar/retry', { action: 'drain_create_only' });
        if (!next || next.ok !== true) throw new Error('登録の進行状況を確認できませんでした。');
        result = next;
        batches++;
        if ((next.batch?.claimed || 0) === 0) break;
      }
      if (result.complete === true && result.pending === 0 && result.failures === 0) {
        message('Googleカレンダーへの初回登録が完了しました。');
      } else if (result.failures > 0) {
        message('登録できない予定があり、安全のため停止しました。状況を確認してください。');
      } else {
        message('同期の一部は処理待ちです。続けるボタンで安全に再開できます。');
      }
    } catch(error) {
      message(error instanceof Error ? error.message : '同期を開始できませんでした。');
    } finally {
      busy = false;
    }
  };

  window.retryShiftPersonalCalendar = async function () {
    if (busy) return;
    busy=true;
    try {
      const result=await post('/api/shifts/line/calendar/retry',{});
      message(result.requeued>0
        ? '安全に再試行できる '+result.requeued+'件を処理待ちに戻しました。'
        : '自動で再試行できる項目はありません。要確認の予定は管理者が照合します。');
      busy=false;
      await window.loadShiftPersonalCalendarSettings();
    } catch(error) {
      message(error instanceof Error ? error.message : '再試行できませんでした。');
      busy=false;
    }
  };
})();
