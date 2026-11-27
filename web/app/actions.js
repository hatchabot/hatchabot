// web/app/actions.js: the page's event actions (onAction, runActions, actionFor), and esc().
// One of the page's classic scripts (HB-0811). web/index.html loads them in
// order and they share one global scope; code that runs at load may reach only
// what this file and the ones before it declare (scripts/check-web.mjs).

/**
 * Event actions (HB-0810). The page's markup holds no code: an element says
 * what an event on it does with data-on-<event>="name", a function in the
 * action table (actionFor), its arguments as JSON in data-on-<event>-args,
 * and data-on-<event>-mods:
 *   prevent  preventDefault() first
 *   stop     stopPropagation(), and no element further out runs its action
 *   return   a false result prevents the default, as an inline handler's did
 *   key=K    keydown: only for that key
 * Several names, space-separated, run in turn, with one argument array each.
 * An argument {$: 'el'} is the element itself; {$: 'value' | 'checked' |
 * 'open' | 'files' | 'file'} that property of it; {$: 'data', k} one of its
 * data- values; {$: 'event'} the event. Markup built in the script gets
 * these attributes from onAction(). With no inline handlers, the page's
 * script policy needs no 'unsafe-inline' for them (HB-0812).
 */
function onAction(type, name, args = [], mods = '') {
  let out = `data-on-${type}="${esc(name)}"`;
  if (args.length) out += ` data-on-${type}-args="${esc(JSON.stringify(args))}"`;
  if (mods) out += ` data-on-${type}-mods="${esc(mods)}"`;
  return out;
}
const ACTION_EVENTS = ['click', 'dblclick', 'change', 'input', 'submit', 'keydown', 'toggle'];
function actionArg(a, el, ev) {
  if (!a || typeof a !== 'object' || Array.isArray(a) || !Object.hasOwn(a, '$')) return a;
  switch (a.$) {
    case 'el': return el;
    case 'event': return ev;
    case 'value': return el.value;
    case 'checked': return el.checked;
    case 'open': return el.open;
    case 'files': return el.files;
    case 'file': return el.files?.[0];
    case 'data': return el.dataset[a.k];
    default: return a;
  }
}
/**
 * An event's actions: on its target, then, for an event that bubbles, on each
 * element out from it, as inline handlers ran. One that does not bubble (a
 * details' toggle, a script's new Event('change')) is caught on its way down,
 * and runs its target's action only.
 */
function runActions(ev) {
  const attr = `data-on-${ev.type}`;
  for (let el = ev.target instanceof Element ? ev.target : null; el; el = ev.bubbles ? el.parentElement : null) {
    const names = el.getAttribute(attr);
    if (!names) continue;
    const mods = (el.getAttribute(`${attr}-mods`) || '').split(' ').filter(Boolean);
    const key = mods.find((m) => m.startsWith('key='))?.slice(4);
    if (key !== undefined && ev.key !== key) continue;
    if (mods.includes('prevent')) ev.preventDefault();
    if (mods.includes('stop')) ev.stopPropagation();
    let args = [];
    try { args = JSON.parse(el.getAttribute(`${attr}-args`) || '[]'); } catch { args = []; }
    const list = names.split(' ');
    const each = list.length > 1 ? args : [args];
    try {
      let result;
      list.forEach((name, i) => {
        const fn = actionFor(name);
        if (!fn) throw new Error(`No action named "${name}" (web/index.html, actionFor)`);
        result = fn(...(each[i] || []).map((x) => actionArg(x, el, ev)));
      });
      if (mods.includes('return') && result === false) ev.preventDefault();
    } catch (e) {
      // As a throwing inline handler did: reported, and the next element's action still runs.
      if (typeof reportError === 'function') reportError(e); else console.error(e);
    }
    if (mods.includes('stop')) break;
  }
}
for (const type of ACTION_EVENTS) {
  document.addEventListener(type, (ev) => { if (ev.bubbles) runActions(ev); });
  document.addEventListener(type, (ev) => { if (!ev.bubbles) runActions(ev); }, true);
}

// What a few actions do that is not one call of a page function.
function closeDialog(id) { $(id).close(); }
function showDialog(id) { $(id).showModal(); }
function clickById(id) { $(id).click(); }
function hideById(id) { $(id).style.display = 'none'; }
function hideWhenChecked(id, checked) { $(id).style.display = checked ? 'none' : ''; }
function enableIfChecked(id, checked) { $(id).disabled = !checked; }
function openInNewTab(url) { window.open(url, '_blank', 'noopener'); }
function scrollToTop() { scrollTo({ top: 0, behavior: 'smooth' }); }
function copyAndSay(text, okMsg, failMsg, okMs, failMs) { return copyText(text).then((ok) => toast(ok ? okMsg : failMsg, ok ? okMs : failMs)); }
function copyFromEl(id, okMsg, failMsg, okMs, failMs) { return copyAndSay($(id).textContent, okMsg, failMsg, okMs, failMs); }
function noteSetupOpen(open) { setupOpen = open; }
function noteRtCapsOpen(open) { rtCapsOpen = open; }
function noteSpendPickOpen(open) { spendPickOpen = open; }
function pricesToggled(el) { if (el.open) return loadModelPrices(); }
function budgetsToggled(el) { if (el.open) return loadBudgets(); }
function bpOpenAgain() { return bpOpen(bp.agent); }
function inviteFromEdit() { return invite(editAgentId, $('editName')?.value || ''); }
function removePoolBotAndList(username) { return removePoolBot(username).then(loadBotInventory); }
/** The Derived images drawer, unfolded: its toggle event loads it and remembers it, as a click on it does. */
function unfoldDerivedDrawer() {
  const d = $('advPart-derived');
  if (d && !d.open) d.open = true;
}
/**
 * ↻ on a derived row of the Runtime images list: its build is followed only with the Derived images
 * drawer unfolded (derivedPanelShown), so it is unfolded first, or its "✓ Built" never came (HB-1525).
 */
function rebuildDerivedImageAndList(name) {
  unfoldDerivedDrawer();
  return rebuildDerivedImage(name).then(loadRuntimeImages);
}
/** Log on a derived row of the Runtime images list: the log is shown in the Derived drawer, so it is unfolded first, and the log scrolled into view (HB-1525 review). */
function showDerivedLogFromList(name) {
  unfoldDerivedDrawer();
  return showDerivedLog(name).then(() => {
    const pre = $('derivedBuildOut');
    if (pre && !pre.hidden) pre.scrollIntoView?.({ block: 'nearest' });
  });
}
function deleteDerivedImageAndList(name) { return deleteDerivedImage(name).then(loadRuntimeImages); }
function dismissSpikeRow(agentId, at, el) { return dismissSpike(agentId, at).then(() => { el.closest('div').remove(); }); }
function saveMachineDefaultOf(key) { return saveMachineDefault(key, $('md-' + key)); }
function editGroupNameOf(el) { return editGroupName(el.closest('.v2ghead').querySelector('h3')); }
function editGroupNameOnEnter(ev, el) { if (ev.key === 'Enter' && !el.isContentEditable) { ev.preventDefault(); editGroupName(el); } }
function v2SetSleep(id, value) { return v2SetAgentPolicy(id, { hibernate: value || null }); }
function v2SetFilesCap(id, value) { return v2SetAgentPolicy(id, { filesMaxMb: value ? Number(value) : null }); }
function v2SetBrowserFrom(id, el) { return v2SetBrowser(id, el.value === 'on', el); }
function v2SetKeepLoginsFrom(id, el) { return v2SetKeepLogins(id, el.value === 'on', el); }
function chanAllowKnocksFrom(id, el) { return chanAllowKnocks(id, el.value === 'on', el); }
function chanRichMessagesFrom(id, el) { return chanRichMessages(id, el.value === 'off', el); }
function chanRoomPicked(kind, value) { const box = $('chanRoom-' + kind); box.hidden = value !== ''; if (value) box.value = value; }
function chanRoomFound(kind, value) { $('chanRoom-' + kind).value = value; }
function chanRoomModeChanged(kind, value) {
  const on = value === 'room', pick = $('chanRoomPick-' + kind), find = $('chanRoomFind-' + kind);
  if (pick) {
    pick.hidden = !on;
    $('chanRoom-' + kind).hidden = !on || kind === 'telegram' || pick.value !== '';
    if (on && pick.value) $('chanRoom-' + kind).value = pick.value;
  } else $('chanRoom-' + kind).hidden = !on;
  if (find) find.hidden = !on;
}

/**
 * The action table: every function an element may name in data-on-<event>.
 * Built at the first event, when every script has run. scripts/check-web.mjs
 * fails when the page names an action that is not here, or one here is not
 * defined.
 */
let ACTIONS;
function actionFor(name) {
  ACTIONS ??= {
    acceptShare, acctBootstrap, acctClaim, acctRecover, acctSignIn, act, addAccount, addAiProfile,
    addChannelPoolBot, addClass, addCronJob, addDataSource, addEnvVar, addGitSource, addHost,
    addKnownPerson, addPeer, addPoolBot, addSetupField, addTodo, adoptInspect, adoptWebChanged,
    agentTelegramChanged, aiKindChanged, aiModelSelectChanged, appConnPicked, appGo,
    applyModelToSelected, appRead, approve, approveConsoleBrowser, archiveAgent, askMgmtForImage,
    askOpsSuggest, assignClass, attachConnection, bpClose, bpGo, bpOpen, bpOpenAgain, bpSend,
    bpToggleShow, bpTypeSend, bringInSelected, budgetsToggled, bumpMemoryCap, cancelCronEdit,
    cancelParamForm, chanAllowKnocksFrom, chanCheckField, chanConnect, chanCopyManifest,
    chanFindRooms, changeMyPassword, chanPasteTokens, chanRecheck, chanRemove, chanRichMessagesFrom,
    chanRoomFound, chanRoomModeChanged, chanRoomPicked, chanSaveRooms, chanSwap, checkDataSource,
    checkpointAgent, choicePick, clearAttention, clearAttentionSection, clickById, cloneAgent,
    closeBackupCodes, closeConsole, closeDialog, closeRecoveryCode, confirmArchive,
    copyAccountInvite, copyAndSay, copyFromEl, copyInvite, copyInviteTg, copyRunnerSetup,
    copyWebChatInvite, createAgent, createApiKeyProfileFromSetup, createFromScratch, createFromTodo,
    createSubscriptionProfile, cronModeChanged, del, delAiProfile, deleteClass, deleteCron,
    deleteDerivedImage, deleteDerivedImageAndList, deleteHost, deleteImageTag, deleteSnapshot,
    delPeer, denyPair, deriveChild, discardTrial, disconnectAccount, dismissConnEnding, dismissContextReset,
    dismissSecurityNotice, dismissShare, dismissSpike, dismissSpikeRow, distillToMaster, doLogin,
    doSendAgent, downloadAgent, downloadBackupCodes, downloadHistory, downloadRecoveryCode,
    drainHost, editCronJob, editGroupName, editGroupNameOf, editGroupNameOnEnter, embedderAction,
    embedMoveAll, enableIfChecked, faApply, faManual, faRenderAction, faSelect, faToggleAll,
    fleetResClear, fleetResSortBy, forgotPassword, goSetupValues, hideById, hideRecoverForm,
    hideWhenChecked, idResendVerification, idSignIn, idSignUp, importAgentFile, installApp,
    installHere, installImage, inviteFromEdit, kick, loadAudit, loadBotInventory,
    loadConnections, loadCrons, loadFleetUsage, loadHealth, loadInbox, loadInspectFile,
    loadLogs, loadPosture, loadReach, loadSetupLog, loadUsage, makeWebChatInvite, matchBotFather,
    moveAgentsApply, moveAgentsToSource, moveAiProfile, moveGroup, moveHostAgent, newCliToken,
    newRecoveryCode, noteRtCapsOpen, noteSetupOpen, noteSpendPickOpen, onEditProfileChange,
    onHostPicked, onParamTypeChange, onRepoPublic, openAdoptDlg, openAiDlg, openAppDlg, openAudit,
    openBudgets, openChanSetup, openConsoleHome, openConsoleSwitcher, openEdit, openFleetActions,
    openFleetResources, openFleetUsage, openGallery, openGateway, openInbox, openInNewTab,
    openInspect, openLogs, openMigrate, openModelPrices, openProposals, openReport, openSendAgent,
    openSetupGuide, openSetupLog, openUsage, openV2Agent, openV2Icon, openWebChat, pickEditFile, pingHost,
    pricesToggled, promoteImage, pruneBackup, pushDefinition, quickClass, reachSetGuests,
    reachSetInvitedOnly, reachSignOut, reachToggleLog, reachTurnOff, reachTurnOn, rebuild,
    rebuildAll, rebuildDerivedImage, rebuildDerivedImageAndList, recAct, recheckPoolApp,
    recheckPoolBot, recNotNow, recoverContext, recoverOp, refreshApplyCount, refreshMoveCount,
    rehostAgent, rememberPublicUrl, removeAccount, removeConnection, removeDataSource, removeEnvVar,
    removeMediaKey, removeOAuthClient, removePoolApp, removePoolBot, removePoolBotAndList,
    removeSearchKey, removeSetupField, removeTodo, renameAgent, renderExtras, renderTryList,
    reopenDoor, reportCopy, reportCreate, reportDiscard, reportOpenIssue, reportSaveFile, reportShow,
    resetSetupValues, resolveProposal, restoreAgent, restoreFromBackup, retryWaitingCrons,
    revealFleetKey, revealInvToken, revealSourceCredential, revertSnapshot, revokeCliToken, runAdopt,
    runBackupNow, runCron, runDrillNow, runMigrate, runsHere, runTryOnAgents, saveAiProfile,
    saveBudget, saveCronTriggers, saveDescription, saveEditFile, saveEmbedMode, saveImagePin,
    saveMachineDefault, saveMachineDefaultOf, saveMediaKey, saveMemoryCap, saveOAuthClient,
    saveOperator, savePeers, saveSearchKey, saveSearchPrice, saveSetupFields, saveSetupValues,
    saveStep, saveSwapAllowance, scrollToTop, selectMoveBySource, sendResetLink, setContextCap,
    setCronNote, setDataAccess, setDefaultSource, setDrillEvery, setEmbedDefault, setMgmtLlmSource,
    setPoolOwnOnly, setRebuildAtOnce, setRebuildPolicy, setSearchMode, setSpendRange,
    settingsAdvToggled, setWebChat, sfAddPasskey, sfCancel, sfConfirmTotp, sfLink, sfNewBackupCodes,
    sfOpen, sfRemove, sfStartTotp, sfSubmitCode, sfUsePasskey, shareAiProfile, shareInviteTg,
    shareTemplate, shareWebChatWith, showBotToken, showDeployKey, showDerivedLog, showDerivedLogFromList, showDialog,
    showInspTab, showMoreInbox, showRecoverForm, showRunnerSetup, showTab, signOut, signOutEverywhere, skipTelegram,
    sortGroup, sourceSpendToggle, spendPickAll, spendPickClose, spendPickOne, startGoogleConnect,
    submitParamForm, submitToken, switchModel, switchProfile, syncBotName, syncModels,
    syncOperatorBtn, takeSnapshot, testAgentGmail, testAgentSearch, testFleetSearch, toggleApplyAll,
    toggleCron, toggleDerivedLines, toggleImageDetails, toggleMoveAll, toggleReveal, tryOnAgent,
    tryPick, tryPickAll, turnOnFamilyAccounts, turnOnServe, unlinkDiscord, unlinkTelegram,
    updateClass, updateSelCount, v2AddTelegram, v2AppRemove, v2AppRetry, v2AppRollback, v2AppUpdate,
    v2AppUpdateWith, v2BulkSection, v2CheckAll, v2ClearChecks, v2Close, v2CloseAccount,
    v2CopySection, v2DismissClassicMap, v2FilesSortBy, v2Fold, v2FoldActivity, v2ForgetLogins,
    v2IconIdeas, v2IconPreview, v2IconSave, v2InlineHealth, v2LoadApp, v2LoadFiles, v2LoadVoice,
    v2MoveInGroup, v2Open, v2OpenFile, v2OpenRec, v2RecoveryChoose, v2RecoveryGo, v2RecoveryToggle,
    v2SetBrowserFrom, v2SetCostPeriod, v2SetFilesCap, v2SetGroup, v2SetKeepLoginsFrom, v2SetSleep,
    v2SetSort, v2SetTheme, v2SetupOps, v2SetupVoice, v2SetView, v2SkillChange, v2SkillOpen,
    v2SkillsChanged, v2SkillsCheck, v2SkillsClose, v2SkillsOpen, v2SkillsRead, v2SkillsSave,
    v2SkillsSetup, v2SkillTry, v2StopCheck, v2TabKeys, v2ToggleAccount, v2ToggleActOp, v2UploadFiles,
    v2VerifyAccess, v2VoiceKeySettings, v2VoiceOpen, webChatSend, wizardAddBot,
  };
  return Object.hasOwn(ACTIONS, name) ? ACTIONS[name] : undefined;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
