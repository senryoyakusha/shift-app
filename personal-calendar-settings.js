/* Three everyday Shift settings: custom stamps, own Google connection, sync.
 * Existing LINE identity, OAuth, Staff scope and provider write flows stay unchanged.
 * No credentials are saved in localStorage. */
(function () {
  'use strict';
  const base = 'https://os.senryoyakusha.com';
  let busy = false;

  function element(id) {
    return document.getElementById(id);
  }

  function message(text) {
    const target = element('shiftPersonalCalendarStatus');
    if (target) target.textContent = text;
  }

  function connectionMessage(text) {
    const target = element('shiftPersonalCalendarConnectionStatus');
    if (target) target.textContent = text;
  }

  function show(id, visible) {
    const target = element(id);
    if (target) target.style.display = visible ? 'block' : 'none';
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
    if (!response.ok) {
      throw new Error(response.status === 503
        ? '連携状態を確認できませんでした。時間をおいて再度開いてください。'
        : response.status === 401
          ? 'LINEのログイン状態を確認してください。'
          : '接続情報を取得できませんでした。');
    }
    return response.json();
  }

  window.loadShiftPersonalCalendarSettings = async function () {
    if (busy) return;
    // Keep potentially unsafe controls hidden until fresh own-Staff status
    // is actually read. Failed requests never reuse stale registration rights.
    show('shiftPersonalCalendarConnectButton', false);
    const connectAction = element('shiftPersonalCalendarConnectButton');
    if (connectAction) connectAction.textContent = 'Googleカレンダーを接続';
    show('shiftPersonalCalendarCreateOnlyPilot', false);
    show('shiftPersonalCalendarRetry', false);
    show('shiftPersonalCalendarIssues', false);
    connectionMessage('接続状態を確認中…');
    message('同期状態を確認中…');
    try {
      const config = await post('/api/shifts/line/config', {});
      const mode = config?.config?.calendarSyncMode;
      if (['none', 'all', 'common'].includes(mode)) {
        const select = element('shiftPersonalCalendarMode');
        if (select) select.value = mode;
      }
      const status = await post('/api/shifts/line/calendar/status', {});
      const selectedMode = status.syncMode || mode || 'none';
      const counts = status.counts || {};
      const pending = (counts.pending || 0) + (counts.processing || 0);
      const failures = (counts.error || 0) + (counts.held || 0);
      const uncertain = counts.uncertainEffects || 0;

      if (!status.connected) {
        connectionMessage('未接続');
        show('shiftPersonalCalendarConnectButton', true);
        message('Googleカレンダーを接続すると同期できます。');
      } else {
        const needsReconnect = status.authorization === 'reauthorization_required'
          || (status.recoveryStaged && status.recoveryStageExpired);
        if (needsReconnect) {
          connectionMessage('再接続が必要です。');
          show('shiftPersonalCalendarConnectButton', true);
        } else if (status.recoveryStaged) {
          connectionMessage('接続の確認中です。');
        } else if (status.authorization === 'ready') {
          connectionMessage(status.accountEmail
            ? '接続済み：' + status.accountEmail
            : 'Googleカレンダー接続済み');
        } else {
          connectionMessage('Google接続を確認してください。');
        }
        const connectButton = element('shiftPersonalCalendarConnectButton');
        if (connectButton && needsReconnect) connectButton.textContent = 'Googleカレンダーを再接続';

        if (status.recoveryStaged) {
          message('接続の確認が終わるまで同期を停止しています。');
        } else if (status.authorization !== 'ready') {
          message('Googleの再接続が必要です。');
        } else if (status.reconciliation === 'review_required' || uncertain > 0) {
          message('同期する予定の確認が必要です。');
        } else if (failures > 0 || status.lastFailure) {
          message('同期できない予定があります。');
        } else if (selectedMode === 'none') {
          message('同期しない設定です。');
        } else if (status.reconciliation !== 'verified_clean') {
          message(status.canCreateOnlyPilot === true
            ? '初回の同期を開始してください。'
            : '同期開始の確認待ちです。');
        } else {
          message(pending > 0
            ? '毎朝5時に自動同期します。未反映 ' + pending + '件'
            : '毎朝5時に自動同期します。');
        }
      }

      const eligible = status.canCreateOnlyPilot === true
        && status.reconciliation === 'pending'
        && ['all', 'common'].includes(selectedMode);
      show('shiftPersonalCalendarCreateOnlyPilot', eligible);
      if (eligible) {
        const button = element('shiftPersonalCalendarCreateOnlyPilot');
        const label = selectedMode === 'all' ? 'すべてのシフト' : '休み・作業日';
        if (button) button.textContent = label + 'をGoogleカレンダーに反映';
      }
      // Retry is useful only for safe transient errors. Held/uncertain Google
      // writes must stay stopped for owner/admin review.
      show('shiftPersonalCalendarRetry', status.connected === true
        && status.authorization === 'ready'
        && !status.recoveryStaged && uncertain === 0
        && (counts.error || 0) > 0);

      const reasonMap = {
        linked_event_missing: 'Google上の予定が見つかりません',
        authorization_lost: 'Googleの再接続が必要です',
        refresh_token_revoked: 'Googleの再接続が必要です',
        retry_exhausted: '同期の再試行が上限に達しました',
        event_ownership_conflict: '予定の確認が必要です',
        connection_changed_during_write: '接続の確認中です',
        uncertain_external_effect: '同期結果の確認が必要です',
        effect_settled_reaudit_required: '予定の確認が必要です',
      };
      const problems = [];
      if (failures > 0) problems.push('失敗・停止 ' + failures + '件');
      if (uncertain > 0) problems.push('結果を確認できない予定 ' + uncertain + '件');
      for (const issue of (status.issues || []).slice(0, 3)) {
        problems.push(String(issue.shiftDate || '対象日不明') + '：'
          + (reasonMap[issue.reason] || '同期結果の確認が必要です'));
      }
      const issues = element('shiftPersonalCalendarIssues');
      if (issues) issues.textContent = problems.join(' ／ ');
      show('shiftPersonalCalendarIssues', problems.length > 0);
    } catch (error) {
      connectionMessage('接続状態を確認できませんでした。');
      message(error instanceof Error ? error.message : '同期状態を確認できませんでした。');
    }
  };

  window.saveShiftPersonalCalendarMode = async function () {
    if (busy) return;
    const mode = element('shiftPersonalCalendarMode')?.value;
    if (!['none', 'all', 'common'].includes(mode)) return;
    busy = true;
    let saved = false;
    try {
      message('同期するシフトを保存しています…');
      await post('/api/shifts/line/config', { syncMode: mode });
      saved = true;
      message('保存しました。');
    } catch (error) {
      message(error instanceof Error ? error.message : '保存できませんでした。');
    } finally {
      busy = false;
    }
    if (saved) await window.loadShiftPersonalCalendarSettings();
  };

  window.connectShiftPersonalCalendar = async function () {
    if (busy) return;
    busy = true;
    try {
      connectionMessage('Googleの接続画面を開いています…');
      const data = await post('/api/shifts/line/calendar/connect', {});
      const url = new URL(data.authorizeUrl);
      if (url.origin !== base || url.pathname !== '/api/shifts/line/calendar/authorize') {
        throw new Error('Googleの接続先を確認できませんでした。');
      }
      if (typeof liff.openWindow === 'function') {
        liff.openWindow({ url: url.toString(), external: true });
      } else {
        window.location.assign(url.toString());
      }
    } catch (error) {
      connectionMessage(error instanceof Error ? error.message : 'Googleに接続できませんでした。');
    } finally {
      busy = false;
    }
  };
  window.activateShiftPersonalCalendarCreateOnlyPilot = async function () {
    if (busy) return;
    busy = true;
    try {
      message('選んだシフトをGoogleカレンダーに登録しています…');
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
        const activateButton = document.getElementById('shiftPersonalCalendarCreateOnlyPilot');
        if (activateButton) activateButton.style.display = 'none';
      } else if (result.failures > 0) {
        message('登録できない予定があり、安全のため停止しました。状況を確認してください。');
      } else {
        message('未反映の予定は毎朝5時に自動処理します。');
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
