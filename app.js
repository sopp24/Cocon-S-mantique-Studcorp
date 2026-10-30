(() => {
  'use strict';

  const STORAGE_KEY = 'studcorpMindmap.v1';
  const AI_CONFIG_KEY = 'studcorpMindmap.aiConfig.v1';
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const deepClone = (obj) => JSON.parse(JSON.stringify(obj));
  const html = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const safeColor = (value) => /^#[0-9a-f]{6}$/i.test(String(value || '')) ? value : '#4AA6B6';
  const DEFAULT_TYPE_LABELS = {root:'Centre de la carte',theme:'Thématique',subtheme:'Grande recherche',volume:'Volume de recherche',page:'Requête cible',hub:'Requête cible secondaire',article:'Page / article'};
  const DEFAULT_TYPE_COLORS = {root:'#2F6674',theme:'#2F6674',subtheme:'#4AA6B6',volume:'#536DFF',page:'#28A745',hub:'#D65A0A',article:'#F3A477'};
  const allowedTypes = () => [...new Set((state.legend || []).map((entry) => entry.type).concat(['theme','subtheme']))];
  const typeLabel = (type) => (state.legend.find((entry) => entry.type === type) || {label: DEFAULT_TYPE_LABELS[type] || type}).label;
  const typeColor = (type) => safeColor((state.legend.find((entry) => entry.type === type) || {}).color || DEFAULT_TYPE_COLORS[type] || '#4AA6B6');
  const slug = (s) => String(s || 'noeud').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'noeud';
  const makeId = (prefix = 'node') => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

  let state;
  let selectedNodeId = null;
  let searchTerm = '';
  let pendingProposal = null;
  let lastAskedPrompt = '';
  let savingTimer = null;
  let busyAI = false;
  let aiConfig = {baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: '', syncUrl: ''};
  let toastTimer = null;

  // Historique d'annulation/rétablissement, limité aux 100 dernières étapes.
  let undoStack = [];
  let redoStack = [];
  let historyLastSnapshot = null;
  let historyPendingBefore = null;
  let historyTimer = null;

  // Synchronisation distante partagée entre les appareils via Cloudflare Durable Objects.
  let syncReady = false;
  let syncBooting = false;
  let syncRevision = 0;
  let syncBaseState = null;
  let syncPollTimer = null;
  let syncPushInFlight = false;
  let syncPushAgain = false;
  const MISSING = Symbol('missing-value');

  // Navigation radiale : surface resserrée, panoramique, zoom et déplacement des bulles.
  const MAP_WORLD_WIDTH = 2280;
  const MAP_WORLD_BASE_HEIGHT = 2800;
  const MAP_ROOT_LEFT = 780;
  const MAP_ROOT_TOP = 850;
  const MAP_ROOT_WIDTH = 700;
  const mapView = {x:0, y:0, scale:0.82, minScale:0.16, maxScale:1.6, initialized:false, dragging:false, pointerId:null, startX:0, startY:0, originX:0, originY:0, suppressClick:false, lastStageWidth:0, lastStageHeight:0};
  const mapPointers = new Map();
  let mapPinch = null;
  let mapNodeDrag = null;
  const MAP_BRANCH_POSITIONS = {
    'section-recherche-de-logement': {left:20, top:45},
    'section-responsabilite-civile': {left:780, top:45},
    'section-complementaire-sante': {left:1540, top:45},
    'section-habitation': {left:20, top:850},
    'section-sante-mobilite': {left:1540, top:850},
    'section-hors-piliers-vie-etudiante-carriere': {left:20, top:1900},
    'section-hors-piliers-actualites-studcorp': {left:1540, top:1900}
  };

  function ensureMapLayout() {
    if (!state.mapLayout || typeof state.mapLayout !== 'object' || Array.isArray(state.mapLayout)) state.mapLayout = {};
  }

  function mapOffsetStyle(id) {
    const offset = state.mapLayout && state.mapLayout[id] || {};
    const dx = Number.isFinite(Number(offset.dx)) ? Number(offset.dx) : 0;
    const dy = Number.isFinite(Number(offset.dy)) ? Number(offset.dy) : 0;
    return `--drag-x:${dx}px;--drag-y:${dy}px`;
  }

  function initialState() {
    const initial = deepClone(window.STUDCORP_INITIAL_DATA || {});
    if (!initial.root || !Array.isArray(initial.root.children)) throw new Error('Les données de départ sont introuvables. Vérifie que data.js est bien présent.');
    if (!initial.mapLayout || typeof initial.mapLayout !== 'object' || Array.isArray(initial.mapLayout)) initial.mapLayout = {};
    return initial;
  }

  function loadState() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && parsed.root && Array.isArray(parsed.root.children) && Array.isArray(parsed.legend)) {
          if (!parsed.mapLayout || typeof parsed.mapLayout !== 'object' || Array.isArray(parsed.mapLayout)) parsed.mapLayout = {};
          return parsed;
        }
      }
    } catch (error) {
      console.warn('Impossible de lire la sauvegarde locale :', error);
    }
    return initialState();
  }

  function loadAIConfig() {
    try {
      const parsed = JSON.parse(localStorage.getItem(AI_CONFIG_KEY) || '{}');
      aiConfig = {...aiConfig, ...parsed};
    } catch (_) { /* use defaults */ }
    $('#syncUrlInput').value = aiConfig.syncUrl || '';
    $('#apiBaseInput').value = aiConfig.baseUrl || 'https://api.openai.com/v1';
    $('#apiModelInput').value = aiConfig.model || 'gpt-4o-mini';
    $('#apiKeyInput').value = aiConfig.apiKey || '';
    updateAIMode();
  }

  function setSaveStatus(message, kind = '') {
    const status = $('#saveStatus');
    if (!status) return;
    status.classList.remove('saving', 'error');
    if (kind) status.classList.add(kind);
    status.innerHTML = `<span class="status-dot"></span> ${html(message)}`;
  }

  function stateSnapshot(value) { return JSON.stringify(value); }
  function statesEqual(a, b) { return stateSnapshot(a) === stateSnapshot(b); }
  function cloneMaybe(value) { return value === MISSING ? MISSING : deepClone(value); }
  function valuesEqual(a, b) {
    if (a === MISSING || b === MISSING) return a === b;
    return stateSnapshot(a) === stateSnapshot(b);
  }
  function isPlainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }

  // Fusion à trois états : les champs modifiés d'un seul côté sont conservés ;
  // si un même champ a été modifié des deux côtés, la valeur locale prévaut.
  function mergeThree(baseValue, localValue, remoteValue) {
    if (valuesEqual(localValue, baseValue)) return cloneMaybe(remoteValue);
    if (valuesEqual(remoteValue, baseValue)) return cloneMaybe(localValue);
    if (valuesEqual(localValue, remoteValue)) return cloneMaybe(localValue);
    if (localValue === MISSING) return cloneMaybe(remoteValue);
    if (remoteValue === MISSING) return cloneMaybe(localValue);
    if (isPlainObject(localValue) && isPlainObject(remoteValue)) {
      const baseObject = isPlainObject(baseValue) ? baseValue : {};
      const result = {};
      const keys = new Set([...Object.keys(baseObject), ...Object.keys(localValue), ...Object.keys(remoteValue)]);
      for (const key of keys) {
        const baseChild = Object.prototype.hasOwnProperty.call(baseObject, key) ? baseObject[key] : MISSING;
        const localChild = Object.prototype.hasOwnProperty.call(localValue, key) ? localValue[key] : MISSING;
        const remoteChild = Object.prototype.hasOwnProperty.call(remoteValue, key) ? remoteValue[key] : MISSING;
        const mergedChild = mergeThree(baseChild, localChild, remoteChild);
        if (mergedChild !== MISSING) result[key] = mergedChild;
      }
      return result;
    }
    return cloneMaybe(localValue);
  }

  function flattenNodeTree(mapState) {
    const output = new Map();
    function visit(node, parentId, index) {
      if (!node || !node.id) return;
      const record = deepClone(node);
      delete record.children;
      record.__parentId = parentId;
      record.__order = index;
      output.set(String(node.id), record);
      (node.children || []).forEach((child, i) => visit(child, String(node.id), i));
    }
    if (mapState && mapState.root) visit(mapState.root, null, 0);
    return output;
  }

  function mergeKeyedList(baseItems = [], localItems = [], remoteItems = [], keyName = 'type') {
    const makeMap = (items) => new Map((items || []).map((item) => [String(item[keyName]), item]));
    const baseMap = makeMap(baseItems), localMap = makeMap(localItems), remoteMap = makeMap(remoteItems);
    const orderedKeys = [...new Set([
      ...(remoteItems || []).map((item) => String(item[keyName])),
      ...(localItems || []).map((item) => String(item[keyName])),
      ...(baseItems || []).map((item) => String(item[keyName]))
    ])];
    const merged = [];
    for (const key of orderedKeys) {
      const item = mergeThree(baseMap.has(key) ? baseMap.get(key) : MISSING,
        localMap.has(key) ? localMap.get(key) : MISSING,
        remoteMap.has(key) ? remoteMap.get(key) : MISSING);
      if (item !== MISSING) merged.push(item);
    }
    return merged;
  }

  function mergeStates(baseState, localState, remoteState) {
    if (!localState) return deepClone(remoteState);
    if (!remoteState) return deepClone(localState);
    const baseNodes = flattenNodeTree(baseState);
    const localNodes = flattenNodeTree(localState);
    const remoteNodes = flattenNodeTree(remoteState);
    const ids = new Set([...baseNodes.keys(), ...localNodes.keys(), ...remoteNodes.keys()]);
    const mergedRecords = new Map();
    for (const id of ids) {
      const record = mergeThree(
        baseNodes.has(id) ? baseNodes.get(id) : MISSING,
        localNodes.has(id) ? localNodes.get(id) : MISSING,
        remoteNodes.has(id) ? remoteNodes.get(id) : MISSING
      );
      if (record !== MISSING) mergedRecords.set(id, record);
    }

    const nodesById = new Map();
    const parentAndOrder = new Map();
    for (const [id, record] of mergedRecords) {
      const node = deepClone(record);
      parentAndOrder.set(id, {parentId: node.__parentId, order: Number(node.__order) || 0});
      delete node.__parentId;
      delete node.__order;
      node.children = [];
      nodesById.set(id, node);
    }
    const rootId = String((localState.root && localState.root.id) || (remoteState.root && remoteState.root.id) || 'root');
    let mergedRoot = nodesById.get(rootId);
    if (!mergedRoot) {
      mergedRoot = deepClone(remoteState.root || localState.root);
      mergedRoot.children = [];
      nodesById.set(rootId, mergedRoot);
      parentAndOrder.set(rootId, {parentId: null, order: 0});
    }
    const childGroups = new Map();
    for (const [id, node] of nodesById) {
      if (id === rootId) continue;
      const info = parentAndOrder.get(id) || {};
      const parentId = nodesById.has(String(info.parentId)) ? String(info.parentId) : rootId;
      if (!childGroups.has(parentId)) childGroups.set(parentId, []);
      childGroups.get(parentId).push({id, node, order: Number(info.order) || 0});
    }
    for (const [parentId, rows] of childGroups) {
      rows.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
      const parent = nodesById.get(parentId) || mergedRoot;
      parent.children = rows.map((row) => row.node);
    }
    mergedRoot.children = mergedRoot.children || [];
    const legend = mergeKeyedList(baseState && baseState.legend, localState.legend, remoteState.legend, 'type');
    const mapLayout = mergeThree(baseState && baseState.mapLayout || {}, localState.mapLayout || {}, remoteState.mapLayout || {});
    return {...deepClone(remoteState), ...deepClone(localState), root: mergedRoot, legend, mapLayout};
  }

  function renderExternalState() {
    selectedNodeId = selectedNodeId && findNode(selectedNodeId) ? selectedNodeId : null;
    pendingProposal = null;
    const proposalBox = $('#proposalBox');
    if (proposalBox) proposalBox.hidden = true;
    resetHistory();
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) { /* remote copy remains safe */ }
    renderMap();
    renderLegend();
    renderInspector();
  }

  function updateHistoryControls() {
    const undo = $('#undoBtn');
    const redo = $('#redoBtn');
    if (undo) undo.disabled = !undoStack.length && !historyPendingBefore;
    if (redo) redo.disabled = !redoStack.length;
  }

  function resetHistory() {
    clearTimeout(historyTimer);
    undoStack = [];
    redoStack = [];
    historyPendingBefore = null;
    historyLastSnapshot = state ? deepClone(state) : null;
    updateHistoryControls();
  }

  function commitHistoryChange() {
    clearTimeout(historyTimer);
    if (historyPendingBefore) {
      if (!statesEqual(historyPendingBefore, state)) {
        undoStack.push(deepClone(historyPendingBefore));
        if (undoStack.length > 100) undoStack.shift();
        redoStack = [];
      }
      historyPendingBefore = null;
    }
    historyLastSnapshot = state ? deepClone(state) : null;
    updateHistoryControls();
  }

  function noteHistoryChange() {
    if (!state) return;
    if (!historyLastSnapshot) { historyLastSnapshot = deepClone(state); return; }
    if (statesEqual(state, historyLastSnapshot)) return;
    if (!historyPendingBefore) historyPendingBefore = deepClone(historyLastSnapshot);
    clearTimeout(historyTimer);
    historyTimer = setTimeout(commitHistoryChange, 420);
    updateHistoryControls();
  }

  function undoChange() {
    commitHistoryChange();
    if (!undoStack.length) return;
    redoStack.push(deepClone(state));
    state = undoStack.pop();
    historyLastSnapshot = deepClone(state);
    historyPendingBefore = null;
    selectedNodeId = selectedNodeId && findNode(selectedNodeId) ? selectedNodeId : null;
    updateHistoryControls();
    renderMap(); renderLegend(); renderInspector();
    flushSave();
    toast('Modification annulée.');
  }

  function redoChange() {
    commitHistoryChange();
    if (!redoStack.length) return;
    undoStack.push(deepClone(state));
    if (undoStack.length > 100) undoStack.shift();
    state = redoStack.pop();
    historyLastSnapshot = deepClone(state);
    historyPendingBefore = null;
    selectedNodeId = selectedNodeId && findNode(selectedNodeId) ? selectedNodeId : null;
    updateHistoryControls();
    renderMap(); renderLegend(); renderInspector();
    flushSave();
    toast('Modification rétablie.');
  }

  function normalizedWorkerUrl(value) {
    let url = String(value || '').trim().replace(/\/+$/, '');
    if (url.endsWith('/api/state')) url = url.slice(0, -'/api/state'.length);
    return url;
  }

  function syncEndpoint() { return aiConfig.syncUrl ? `${normalizedWorkerUrl(aiConfig.syncUrl)}/api/state` : ''; }

  function hasUnsyncedChanges() {
    return !syncBaseState || !statesEqual(state, syncBaseState);
  }

  async function readSharedDocument() {
    const response = await fetch(syncEndpoint(), {method: 'GET', cache: 'no-store'});
    if (!response.ok) throw new Error(`Lecture du stockage partagé impossible (HTTP ${response.status}).`);
    return response.json();
  }

  async function startSharedSync() {
    clearInterval(syncPollTimer);
    syncPollTimer = null;
    syncReady = false;
    syncBooting = false;
    syncRevision = 0;
    syncBaseState = null;
    if (!aiConfig.syncUrl) {
      setSaveStatus('Enregistré sur cet appareil');
      return;
    }
    syncBooting = true;
    setSaveStatus('Connexion au stockage partagé…', 'saving');
    try {
      const document = await readSharedDocument();
      if (document && document.state) {
        // Au démarrage, l’état partagé est la version de référence de tous les appareils.
        state = deepClone(document.state);
        syncRevision = Number(document.revision) || 0;
        syncBaseState = deepClone(document.state);
        renderExternalState();
      } else {
        syncRevision = 0;
        syncBaseState = null;
      }
      syncReady = true;
      syncBooting = false;
      if (hasUnsyncedChanges()) await pushSharedState();
      else setSaveStatus('Synchronisé entre les appareils');
      syncPollTimer = setInterval(pollSharedState, 5000);
    } catch (error) {
      syncBooting = false;
      syncReady = false;
      setSaveStatus('Synchronisation indisponible · local conservé', 'error');
      toast(`Synchronisation non disponible : ${error.message || error}. Vérifie l’URL du Worker et son origine autorisée.`, 'error');
    }
  }

  async function pollSharedState() {
    if (!aiConfig.syncUrl || !syncReady || syncPushInFlight) return;
    try {
      const document = await readSharedDocument();
      const remoteRevision = Number(document.revision) || 0;
      if (remoteRevision <= syncRevision || !document.state) return;
      if (hasUnsyncedChanges()) return; // le prochain PUT effectuera une fusion versionnée.
      state = deepClone(document.state);
      syncRevision = remoteRevision;
      syncBaseState = deepClone(document.state);
      renderExternalState();
      setSaveStatus('Synchronisé entre les appareils');
    } catch (error) {
      setSaveStatus('Connexion partagée interrompue · local conservé', 'error');
    }
  }

  async function pushSharedState() {
    if (!aiConfig.syncUrl || !syncReady) return;
    if (syncPushInFlight) { syncPushAgain = true; return; }
    syncPushInFlight = true;
    let finished = false;
    setSaveStatus('Synchronisation…', 'saving');
    try {
      for (let attempt = 0; attempt < 6; attempt++) {
        if (!hasUnsyncedChanges()) {
          setSaveStatus('Synchronisé entre les appareils');
          finished = true;
          break;
        }
        const submittedState = deepClone(state);
        const response = await fetch(syncEndpoint(), {
          method: 'PUT',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({state: submittedState, baseRevision: syncRevision})
        });
        const document = await response.json().catch(() => ({}));
        if (response.status === 409 && document.state) {
          const previousBase = syncBaseState ? deepClone(syncBaseState) : null;
          const merged = mergeStates(previousBase, deepClone(state), document.state);
          syncRevision = Number(document.revision) || 0;
          syncBaseState = deepClone(document.state);
          if (!statesEqual(state, merged)) {
            state = merged;
            renderExternalState();
          }
          continue;
        }
        if (!response.ok) throw new Error(document.error || `Sauvegarde partagée impossible (HTTP ${response.status}).`);
        syncRevision = Number(document.revision) || syncRevision + 1;
        syncBaseState = deepClone(document.state || submittedState);
        if (statesEqual(state, submittedState)) {
          setSaveStatus('Synchronisé entre les appareils');
          finished = true;
          break;
        }
      }
      if (!finished && hasUnsyncedChanges()) throw new Error('La carte a changé trop souvent pendant la synchronisation. Réessaie dans un instant.');
    } catch (error) {
      setSaveStatus('Synchronisation en échec · local conservé', 'error');
      console.warn('Synchronisation STUDCORP impossible :', error);
    } finally {
      syncPushInFlight = false;
      if (syncPushAgain) {
        syncPushAgain = false;
        if (hasUnsyncedChanges()) pushSharedState();
      }
    }
  }

  function flushSave(showToast = false) {
    clearTimeout(savingTimer);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      if (aiConfig.syncUrl) {
        if (syncReady) {
          if (hasUnsyncedChanges()) pushSharedState();
          else setSaveStatus('Synchronisé entre les appareils');
        } else {
          setSaveStatus('Enregistré localement · synchronisation en attente', 'saving');
        }
      } else {
        setSaveStatus('Enregistré sur cet appareil');
      }
      if (showToast) toast(aiConfig.syncUrl ? 'Modifications enregistrées ; synchronisation en cours.' : 'Modifications enregistrées sur cet appareil.');
      return true;
    } catch (error) {
      setSaveStatus('Sauvegarde impossible', 'error');
      toast('Le navigateur ne permet pas de sauvegarder. Exporte un JSON pour conserver tes changements.', 'error');
      return false;
    }
  }

  function saveState(showToast = false) {
    noteHistoryChange();
    const status = $('#saveStatus');
    if (status) {
      status.classList.add('saving');
      status.classList.remove('error');
      status.innerHTML = '<span class="status-dot"></span> Enregistrement…';
    }
    clearTimeout(savingTimer);
    savingTimer = setTimeout(() => flushSave(showToast), 120);
  }

  function findNode(id, node = state.root) {
    if (!node) return null;
    if (node.id === id) return node;
    for (const child of node.children || []) {
      const found = findNode(id, child);
      if (found) return found;
    }
    return null;
  }

  function findParent(id, node = state.root, parent = null) {
    if (!node) return null;
    if (node.id === id) return parent;
    for (const child of node.children || []) {
      const found = findParent(id, child, node);
      if (found) return found;
    }
    return null;
  }

  function allNodes(node = state.root, acc = []) {
    if (!node) return acc;
    acc.push(node);
    (node.children || []).forEach((child) => allNodes(child, acc));
    return acc;
  }

  function allDescendantCount(node) {
    let count = 0;
    (node.children || []).forEach((child) => { count += 1 + allDescendantCount(child); });
    return count;
  }

  function leafCount(node, predicate) {
    let n = 0;
    for (const item of node.children || []) {
      if (!item.children || !item.children.length) {
        if (!predicate || predicate(item)) n++;
      } else n += leafCount(item, predicate);
    }
    return n;
  }

  function textForSearch(node) {
    const meta = Object.entries(node.meta || {}).map(([key, value]) => `${key} ${value ?? ''}`).join(' ');
    return `${node.label || ''} ${node.note || ''} ${meta}`.toLocaleLowerCase('fr');
  }

  function subtreeMatches(node) {
    if (!searchTerm) return true;
    if (textForSearch(node).includes(searchTerm)) return true;
    return (node.children || []).some(subtreeMatches);
  }

  function nodeDimClass(node) {
    return searchTerm && !subtreeMatches(node) ? ' is-dimmed' : (searchTerm ? ' is-match' : '');
  }

  function titleWithNote(node) {
    const noteIcon = node.note && node.note.trim() ? '<span class="note-mark" title="Une note est renseignée">✎</span>' : '';
    return `${html(node.label || 'Étiquette sans titre')}${noteIcon}`;
  }

  function linkIsValid(url) { return /^https?:\/\//i.test(String(url || '')); }

  function renderRoot() {
    const root = state.root;
    $('#rootWrap').innerHTML = `
      <button type="button" class="root-card" id="root-card" data-select-id="${html(root.id)}" style="--node-color:${typeColor('root')}">
        <span class="node-title"><span class="root-mark">S</span>${titleWithNote(root)}</span>
        <span class="node-subtitle">Carte éditoriale · ${state.root.children.length} branches principales</span>
        ${root.note ? `<p class="root-note">${html(root.note)}</p>` : ''}
      </button>`;
  }

  function renderLeaf(node) {
    const color = typeColor(node.type);
    const volume = node.meta && node.meta.searchVolume;
    const url = node.meta && node.meta.url;
    const query = node.meta && node.meta.query;
    const category = node.meta && node.meta.currentCategory;
    const noteLabel = node.note && node.note.trim() ? '<span class="leaf-badge">✎ note</span>' : '';
    let metaBadges = '';
    if (volume) metaBadges += `<span class="leaf-badge volume">${html(volume)} recherches</span>`;
    if (node.meta && node.meta.publicationDate) metaBadges += `<span class="leaf-badge">${html(node.meta.publicationDate)}</span>`;
    if (category) metaBadges += `<span class="leaf-badge">${html(category)}</span>`;
    if (query && node.type !== 'volume') metaBadges += `<span class="leaf-badge">${html(query)}</span>`;
    metaBadges += noteLabel;
    const link = linkIsValid(url) ? `<a class="leaf-link" href="${html(url)}" target="_blank" rel="noopener noreferrer" title="Ouvrir la page">Ouvrir la page ↗</a>` : '';
    return `
      <div class="leaf-node${node.id === selectedNodeId ? ' is-selected' : ''}${nodeDimClass(node)}" data-select-id="${html(node.id)}" data-map-drag="leaf" data-map-node-id="${html(node.id)}" style="--node-color:${color};${mapOffsetStyle(node.id)}" role="button" tabindex="0" aria-label="Déplacer ou modifier ${html(node.label)}">
        <span class="leaf-accent"></span>
        <span class="leaf-content">
          <span class="leaf-title">${titleWithNote(node)}</span>
          ${(metaBadges || link || node.type) ? `<span class="leaf-meta"><span class="leaf-badge">${html(typeLabel(node.type))}</span>${metaBadges}${link}</span>` : ''}
        </span>
      </div>`;
  }

  function renderSubtheme(node) {
    const isOpen = node.expanded !== false;
    const color = typeColor(node.type);
    const children = node.children || [];
    const childrenHtml = isOpen ? `
      <div class="leaf-list">
        ${children.map(renderLeafOrNested).join('')}
        <button class="add-inline" type="button" data-action="add-leaf" data-parent-id="${html(node.id)}"><span aria-hidden="true">＋</span> Ajouter une étiquette</button>
      </div>` : '';
    return `
      <div class="subtheme${nodeDimClass(node)}" data-subtheme-id="${html(node.id)}" style="--node-color:${color};${mapOffsetStyle(node.id)}">
        <div class="subtheme-head">
          <button class="subtheme-toggle" type="button" data-action="toggle-node" data-node-id="${html(node.id)}" title="${isOpen ? 'Replier' : 'Déplier'}">${isOpen ? '⌄' : '›'}</button>
          <button class="subtheme-title" type="button" data-select-id="${html(node.id)}" data-map-drag="subtheme" data-map-node-id="${html(node.id)}" title="Faire glisser pour déplacer ce groupe">${titleWithNote(node)} <span class="node-count">${children.length}</span></button>
          <div class="subtheme-tools">
            <button class="icon-button" type="button" data-action="add-leaf" data-parent-id="${html(node.id)}" title="Ajouter une étiquette" aria-label="Ajouter une étiquette">＋</button>
            <button class="icon-button" type="button" data-select-id="${html(node.id)}" title="Modifier la sous-thématique" aria-label="Modifier la sous-thématique">✎</button>
          </div>
        </div>
        ${childrenHtml}
      </div>`;
  }

  function renderLeafOrNested(node) {
    if ((node.type === 'subtheme' && !(node.meta && node.meta.isKeyword)) || (node.children && node.children.length)) return renderSubtheme(node);
    return renderLeaf(node);
  }

  function renderSection(section) {
    const isOpen = section.expanded !== false;
    const color = typeColor(section.type);
    const children = section.children || [];
    const body = isOpen ? `
      <div class="branch-body">
        ${children.map(renderLeafOrNested).join('')}
        <button class="add-inline" type="button" data-action="add-subtheme" data-parent-id="${html(section.id)}"><span aria-hidden="true">＋</span> Ajouter une sous-section</button>
      </div>` : '';
    return `
      <article class="branch-card${nodeDimClass(section)}" data-branch-id="${html(section.id)}" style="--node-color:${color}">
        <header class="branch-head" data-connector-id="${html(section.id)}">
          <button class="branch-toggle" type="button" data-action="toggle-node" data-node-id="${html(section.id)}" title="${isOpen ? 'Replier la section' : 'Ouvrir la section'}">${isOpen ? '⌄' : '›'}</button>
          <button class="branch-name" type="button" data-select-id="${html(section.id)}" data-map-drag="branch" data-map-node-id="${html(section.id)}" title="Faire glisser pour déplacer cette branche">${titleWithNote(section)}</button>
          <span class="node-count">${children.length}</span>
          <div class="branch-tools">
            <button class="icon-button" type="button" data-action="add-subtheme" data-parent-id="${html(section.id)}" title="Ajouter une sous-section" aria-label="Ajouter une sous-section">＋</button>
            <button class="icon-button" type="button" data-select-id="${html(section.id)}" title="Modifier la section" aria-label="Modifier la section">✎</button>
          </div>
        </header>
        ${body}
      </article>`;
  }

  function renderMap() {
    renderRoot();
    $('#branches').innerHTML = state.root.children.map(renderSection).join('');
    const nodes = allNodes();
    const contentLabels = nodes.filter((n) => ['article','page','hub','volume'].includes(n.type) || (n.meta && n.meta.isKeyword)).length;
    $('#mapCounts').innerHTML = `
      <span class="count-chip"><strong>${state.root.children.length}</strong> sections</span>
      <span class="count-chip"><strong>${nodes.filter((n) => n.type === 'subtheme').length}</strong> sous-thèmes</span>
      <span class="count-chip"><strong>${contentLabels}</strong> étiquettes</span>`;
    ensureMapLayout();
    positionMapBranches();
    requestAnimationFrame(() => {
      if (!mapView.initialized) {
        mapView.initialized = true;
        centerMapOnRoot(getResponsiveInitialScale());
      }
      drawConnectors();
    });
  }

  function positionMapBranches() {
    const world = $('#mapWorld');
    const cards = $$('.branch-card', $('#branches'));
    if (!world) return;
    ensureMapLayout();
    let extraIndex = 0;
    cards.forEach((card) => {
      const id = card.dataset.branchId;
      const saved = state.mapLayout[id];
      const known = MAP_BRANCH_POSITIONS[id];
      const fallback = {left:20 + (extraIndex % 2 ? 1520 : 0), top:2350 + Math.floor(extraIndex / 2) * 520};
      const position = saved && Number.isFinite(Number(saved.x)) && Number.isFinite(Number(saved.y))
        ? {left:Number(saved.x),top:Number(saved.y)}
        : (known || fallback);
      if (!known) extraIndex += 1;
      card.style.left = `${position.left}px`;
      card.style.top = `${position.top}px`;
    });
    world.style.width = `${MAP_WORLD_WIDTH}px`;
    world.style.height = `${Math.max(MAP_WORLD_BASE_HEIGHT, 2350 + Math.ceil(extraIndex / 2) * 520)}px`;
  }

  function updateMapTransform() {
    const world = $('#mapWorld');
    if (!world) return;
    world.style.transform = `translate(${mapView.x}px, ${mapView.y}px) scale(${mapView.scale})`;
    const label = $('#mapZoomLevel');
    if (label) label.textContent = `${Math.round(mapView.scale * 100)}%`;
  }

  function getResponsiveInitialScale() {
    const width = $('#mapStage')?.clientWidth || window.innerWidth;
    if (width <= 740) return 0.72;
    if (width <= 1050) return 0.80;
    return 0.88;
  }

  function rememberMapViewportSize(stage) {
    mapView.lastStageWidth = stage.clientWidth;
    mapView.lastStageHeight = stage.clientHeight;
  }

  function centerMapOnRoot(scale = mapView.scale) {
    const stage = $('#mapStage');
    if (!stage) return;
    mapView.scale = Math.max(mapView.minScale, Math.min(mapView.maxScale, scale));
    const rootCenterX = MAP_ROOT_LEFT + MAP_ROOT_WIDTH / 2;
    const rootCenterY = MAP_ROOT_TOP + 75;
    mapView.x = stage.clientWidth / 2 - rootCenterX * mapView.scale;
    mapView.y = stage.clientHeight / 2 - rootCenterY * mapView.scale;
    rememberMapViewportSize(stage);
    updateMapTransform();
  }

  function fitMapToViewport() {
    const stage = $('#mapStage');
    const world = $('#mapWorld');
    if (!stage || !world) return;
    const scale = Math.min((stage.clientWidth - 48) / world.offsetWidth, (stage.clientHeight - 48) / world.offsetHeight);
    mapView.scale = Math.max(mapView.minScale, Math.min(0.8, scale));
    mapView.x = (stage.clientWidth - world.offsetWidth * mapView.scale) / 2;
    mapView.y = (stage.clientHeight - world.offsetHeight * mapView.scale) / 2;
    rememberMapViewportSize(stage);
    updateMapTransform();
  }

  function zoomMapAt(factor, clientX, clientY) {
    const stage = $('#mapStage');
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const anchorX = clientX == null ? stage.clientWidth / 2 : clientX - rect.left;
    const anchorY = clientY == null ? stage.clientHeight / 2 : clientY - rect.top;
    const nextScale = Math.max(mapView.minScale, Math.min(mapView.maxScale, mapView.scale * factor));
    const worldX = (anchorX - mapView.x) / mapView.scale;
    const worldY = (anchorY - mapView.y) / mapView.scale;
    mapView.x = anchorX - worldX * nextScale;
    mapView.y = anchorY - worldY * nextScale;
    mapView.scale = nextScale;
    updateMapTransform();
  }

  function setDraggedBubblePosition(drag) {
    const position = state.mapLayout[drag.id] || {};
    if (drag.kind === 'branch') {
      const x = Number.isFinite(Number(position.x)) ? Number(position.x) : drag.initial.x;
      const y = Number.isFinite(Number(position.y)) ? Number(position.y) : drag.initial.y;
      drag.element.style.left = `${x}px`;
      drag.element.style.top = `${y}px`;
    } else {
      const dx = Number.isFinite(Number(position.dx)) ? Number(position.dx) : 0;
      const dy = Number.isFinite(Number(position.dy)) ? Number(position.dy) : 0;
      drag.element.style.setProperty('--drag-x', `${dx}px`);
      drag.element.style.setProperty('--drag-y', `${dy}px`);
    }
  }

  function startMapBubbleDrag(event, handle) {
    if (event.button !== 0 && event.pointerType !== 'touch') return;
    const kind = handle.dataset.mapDrag;
    const id = handle.dataset.mapNodeId;
    if (!kind || !id) return;
    if (event.target.closest('a, .branch-toggle, .subtheme-toggle, .branch-tools, .subtheme-tools, .icon-button, .add-inline')) return;
    const element = kind === 'branch' ? handle.closest('.branch-card')
      : kind === 'subtheme' ? handle.closest('.subtheme')
      : handle.closest('.leaf-node');
    if (!element) return;

    event.stopPropagation();
    ensureMapLayout();
    const current = state.mapLayout[id] || {};
    const initial = kind === 'branch'
      ? {x:Number.isFinite(Number(current.x)) ? Number(current.x) : Number.parseFloat(element.style.left) || MAP_BRANCH_POSITIONS[id]?.left || 0,
         y:Number.isFinite(Number(current.y)) ? Number(current.y) : Number.parseFloat(element.style.top) || MAP_BRANCH_POSITIONS[id]?.top || 0}
      : {dx:Number(current.dx) || 0,dy:Number(current.dy) || 0};
    mapNodeDrag = {kind,id,element,initial,startX:event.clientX,startY:event.clientY,lastX:event.clientX,lastY:event.clientY,moved:false};
    element.classList.add('is-map-dragging');
    if (kind === 'branch') element.style.zIndex = '12';
    const pointerId = event.pointerId;

    const move = (moveEvent) => {
      if (!mapNodeDrag || moveEvent.pointerId !== pointerId) return;
      if (!mapNodeDrag.moved && Math.hypot(moveEvent.clientX - mapNodeDrag.startX, moveEvent.clientY - mapNodeDrag.startY) < 4) return;
      mapNodeDrag.moved = true;
      const dx = (moveEvent.clientX - mapNodeDrag.lastX) / mapView.scale;
      const dy = (moveEvent.clientY - mapNodeDrag.lastY) / mapView.scale;
      mapNodeDrag.lastX = moveEvent.clientX;
      mapNodeDrag.lastY = moveEvent.clientY;
      const saved = state.mapLayout[id] || {};
      if (kind === 'branch') {
        saved.x = (Number.isFinite(Number(saved.x)) ? Number(saved.x) : initial.x) + dx;
        saved.y = (Number.isFinite(Number(saved.y)) ? Number(saved.y) : initial.y) + dy;
      } else {
        saved.dx = (Number(saved.dx) || 0) + dx;
        saved.dy = (Number(saved.dy) || 0) + dy;
      }
      state.mapLayout[id] = saved;
      setDraggedBubblePosition(mapNodeDrag);
      requestAnimationFrame(drawConnectors);
    };

    const finish = (finishEvent) => {
      if (finishEvent.pointerId !== pointerId) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      if (!mapNodeDrag) return;
      const didMove = mapNodeDrag.moved;
      element.classList.remove('is-map-dragging');
      if (kind === 'branch') element.style.zIndex = '';
      mapNodeDrag = null;
      if (didMove) {
        mapView.suppressClick = true;
        window.setTimeout(() => { mapView.suppressClick = false; }, 500);
        saveState();
        commitHistoryChange();
        drawConnectors();
      }
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  }

  function connectorPath(parentRect, childRect) {
    const parentCenter = {x:parentRect.left + parentRect.width / 2,y:parentRect.top + parentRect.height / 2};
    const childCenter = {x:childRect.left + childRect.width / 2,y:childRect.top + childRect.height / 2};
    const dx = childCenter.x - parentCenter.x;
    const dy = childCenter.y - parentCenter.y;
    const parentRatio = Math.max(Math.abs(dx) / Math.max(parentRect.width / 2, 1), Math.abs(dy) / Math.max(parentRect.height / 2, 1), 0.001);
    const childRatio = Math.max(Math.abs(dx) / Math.max(childRect.width / 2, 1), Math.abs(dy) / Math.max(childRect.height / 2, 1), 0.001);
    const sx = parentCenter.x + dx / parentRatio;
    const sy = parentCenter.y + dy / parentRatio;
    const tx = childCenter.x - dx / childRatio;
    const ty = childCenter.y - dy / childRatio;
    const horizontal = Math.abs(dx) >= Math.abs(dy);
    const bend = Math.max(35, (horizontal ? Math.abs(tx - sx) : Math.abs(ty - sy)) * 0.34);
    const c1x = horizontal ? sx + Math.sign(dx) * bend : sx;
    const c1y = horizontal ? sy : sy + Math.sign(dy) * bend;
    const c2x = horizontal ? tx - Math.sign(dx) * bend : tx;
    const c2y = horizontal ? ty : ty - Math.sign(dy) * bend;
    return `M ${sx.toFixed(1)} ${sy.toFixed(1)} C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${tx.toFixed(1)} ${ty.toFixed(1)}`;
  }

  function initMapNavigation() {
    const stage = $('#mapStage');
    if (!stage || stage.dataset.navigationReady === 'true') return;
    stage.dataset.navigationReady = 'true';

    stage.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 && event.pointerType !== 'touch') return;
      const dragHandle = event.target.closest('[data-map-drag]');
      if (dragHandle) {
        startMapBubbleDrag(event, dragHandle);
        if (mapNodeDrag) return;
      }
      if (event.target.closest('.map-controls, button, a, input, textarea, select, [data-select-id], [data-action]')) return;
      mapPointers.set(event.pointerId, {x:event.clientX,y:event.clientY});
      if (mapPointers.size >= 2) {
        mapView.dragging = false;
        mapView.pointerId = null;
        stage.classList.remove('is-panning');
        const points = Array.from(mapPointers.values()).slice(0,2);
        const rect = stage.getBoundingClientRect();
        const midX = (points[0].x + points[1].x) / 2 - rect.left;
        const midY = (points[0].y + points[1].y) / 2 - rect.top;
        mapPinch = {
          distance:Math.hypot(points[1].x-points[0].x,points[1].y-points[0].y),
          scale:mapView.scale,
          anchorX:(midX-mapView.x)/mapView.scale,
          anchorY:(midY-mapView.y)/mapView.scale
        };
        return;
      }
      mapView.dragging = true;
      mapView.pointerId = event.pointerId;
      mapView.startX = event.clientX;
      mapView.startY = event.clientY;
      mapView.originX = mapView.x;
      mapView.originY = mapView.y;
      stage.classList.add('is-panning');
      try { stage.setPointerCapture(event.pointerId); } catch (_) {}
    });

    stage.addEventListener('pointermove', (event) => {
      if (mapPointers.has(event.pointerId)) mapPointers.set(event.pointerId, {x:event.clientX,y:event.clientY});
      if (mapPinch && mapPointers.size >= 2) {
        const points = Array.from(mapPointers.values()).slice(0,2);
        const rect = stage.getBoundingClientRect();
        const midX = (points[0].x + points[1].x) / 2 - rect.left;
        const midY = (points[0].y + points[1].y) / 2 - rect.top;
        const distance = Math.max(1, Math.hypot(points[1].x-points[0].x,points[1].y-points[0].y));
        mapView.scale = Math.max(mapView.minScale, Math.min(mapView.maxScale, mapPinch.scale * distance / Math.max(1,mapPinch.distance)));
        mapView.x = midX - mapPinch.anchorX * mapView.scale;
        mapView.y = midY - mapPinch.anchorY * mapView.scale;
        updateMapTransform();
        return;
      }
      if (!mapView.dragging || event.pointerId !== mapView.pointerId) return;
      mapView.x = mapView.originX + event.clientX - mapView.startX;
      mapView.y = mapView.originY + event.clientY - mapView.startY;
      updateMapTransform();
    });

    const stopDragging = (event) => {
      mapPointers.delete(event.pointerId);
      if (mapPointers.size < 2) mapPinch = null;
      if (event.pointerId !== mapView.pointerId) return;
      mapView.dragging = false;
      mapView.pointerId = null;
      stage.classList.remove('is-panning');
      try { stage.releasePointerCapture(event.pointerId); } catch (_) {}
    };
    stage.addEventListener('pointerup', stopDragging);
    stage.addEventListener('pointercancel', stopDragging);
    stage.addEventListener('wheel', (event) => {
      event.preventDefault();
      zoomMapAt(event.deltaY < 0 ? 1.09 : 0.91, event.clientX, event.clientY);
    }, {passive:false});

    $('#mapZoomIn').addEventListener('click', () => zoomMapAt(1.16));
    $('#mapZoomOut').addEventListener('click', () => zoomMapAt(1 / 1.16));
    $('#mapCenterBtn').addEventListener('click', () => centerMapOnRoot());
    $('#mapFitBtn').addEventListener('click', fitMapToViewport);
  }

  function drawConnectors() {
    const world = $('#mapWorld');
    const svg = $('#connectors');
    const rootCard = $('#root-card');
    if (!world || !svg || !rootCard) return;
    const worldRect = world.getBoundingClientRect();
    const scale = mapView.scale || 1;
    const width = world.offsetWidth || MAP_WORLD_WIDTH;
    const height = world.offsetHeight || MAP_WORLD_BASE_HEIGHT;
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);

    const toWorldRect = (element) => {
      const rect = element.getBoundingClientRect();
      return {left:(rect.left-worldRect.left)/scale,top:(rect.top-worldRect.top)/scale,width:rect.width/scale,height:rect.height/scale};
    };
    const rootRect = toWorldRect(rootCard);
    const globalPaths = $$('.branch-card', $('#branches')).map((card) => {
      const head = $('[data-connector-id]', card) || card;
      return `<path class="connector-main" d="${connectorPath(rootRect,toWorldRect(head))}"/>`;
    }).join('');
    svg.innerHTML = globalPaths;
  }
  function renderLegend() {
    const editor = $('#legendEditor');
    editor.innerHTML = state.legend.map((item, index) => `
      <div class="legend-row" data-legend-type="${html(item.type)}">
        <label class="legend-color" style="--node-color:${safeColor(item.color)}" title="Couleur pour ${html(item.label)}"><input aria-label="Couleur ${html(item.label)}" type="color" value="${safeColor(item.color)}" data-legend-index="${index}" data-legend-field="color"></label>
        <input class="legend-label" aria-label="Libellé de légende" value="${html(item.label)}" data-legend-index="${index}" data-legend-field="label">
        <button class="legend-remove" type="button" data-action="remove-legend" data-legend-type="${html(item.type)}" title="Supprimer « ${html(item.label)} »" aria-label="Supprimer ${html(item.label)}">×</button>
      </div>`).join('');
  }

  function fieldHtml(label, key, value, opts = {}) {
    const type = opts.type || 'text';
    const placeholder = opts.placeholder ? ` placeholder="${html(opts.placeholder)}"` : '';
    const hint = opts.hint ? `<p class="field-note">${html(opts.hint)}</p>` : '';
    const attrs = `data-inspector-field="${html(key)}"`;
    if (type === 'textarea') return `<div class="field"><label for="ins-${html(key)}">${html(label)}</label><textarea id="ins-${html(key)}" ${attrs}${placeholder}>${html(value || '')}</textarea>${hint}</div>`;
    return `<div class="field"><label for="ins-${html(key)}">${html(label)}</label><input id="ins-${html(key)}" type="${type}" ${attrs} value="${html(value || '')}"${placeholder}>${hint}</div>`;
  }

  function renderInspector() {
    const body = $('#inspectorBody');
    const node = selectedNodeId ? findNode(selectedNodeId) : null;
    if (!node) {
      body.innerHTML = '<div class="empty-state"><span class="empty-icon">↖</span><strong>Sélectionne une étiquette</strong><p>Ses informations, ses liens et ses notes apparaîtront ici.</p></div>';
      return;
    }
    const options = [...new Set(allowedTypes().concat(node.type || []))].filter((t) => t !== 'root').map((type) => `<option value="${html(type)}" ${node.type === type ? 'selected' : ''}>${html(typeLabel(type))}</option>`).join('');
    const typeField = node.type === 'root' ? '' : `<div class="field"><label for="ins-type">Type de nœud</label><select id="ins-type" data-inspector-field="type">${options}</select></div>`;
    const meta = node.meta || {};
    const showMeta = node.type === 'article' || node.type === 'page' || node.type === 'hub' || node.type === 'volume' || Object.keys(meta).length > 0;
    const metaFields = showMeta ? `
      <div class="field-grid">
        ${fieldHtml('Requête cible','meta.query',meta.query || '')}
        ${fieldHtml('Volume de recherche','meta.searchVolume',meta.searchVolume || '')}
      </div>
      <div class="field-grid">
        ${fieldHtml('Position SERP','meta.serpPosition',meta.serpPosition ?? '', {placeholder:'Ex. 4'})}
        ${fieldHtml('Date de publication','meta.publicationDate',meta.publicationDate || '')}
      </div>
      ${fieldHtml('Rubrique actuelle','meta.currentCategory',meta.currentCategory || '')}
      ${fieldHtml('Cible','meta.audience',meta.audience || '')}
      ${fieldHtml('URL de la page','meta.url',meta.url || '', {placeholder:'https://… ou « a venir »'})}
      ${fieldHtml('Remarque du tableur','meta.remark',meta.remark || '', {type:'textarea'})}
      ${meta.sourceRow ? `<p class="field-note">Ligne source du tableur : ${html(meta.sourceRow)}${meta.sourceTheme ? ` · ${html(meta.sourceTheme)}` : ''}</p>` : ''}` : '';
    const isRoot = node.id === state.root.id;
    body.innerHTML = `
      <div class="selected-chip"><span style="width:7px;height:7px;background:${typeColor(node.type)};border-radius:2px"></span>${html(typeLabel(node.type))} · ${html(node.id)}</div>
      ${fieldHtml('Titre de l’étiquette','label',node.label)}
      ${typeField}
      ${fieldHtml('Notes / commentaires','note',node.note || '', {type:'textarea', placeholder:'Ajoute du contexte, une idée ou une action à suivre…'})}
      ${metaFields}
      <div class="inspector-actions">
        ${!isRoot ? '<button class="button danger-button button-small" type="button" data-action="delete-node" data-node-id="'+html(node.id)+'">Supprimer</button>' : '<span></span>'}
        <button class="button button-soft button-small" type="button" data-action="copy-node-link" data-node-id="${html(node.id)}">Copier l’URL</button>
      </div>`;
  }

  function renderAll() {
    renderMap();
    renderLegend();
    renderInspector();
    updateAIMode();
    saveState();
  }

  function toast(message, kind = '') {
    const region = $('#toastRegion');
    const element = document.createElement('div');
    element.className = `toast ${kind}`;
    element.textContent = message;
    region.appendChild(element);
    setTimeout(() => element.remove(), 3600);
  }

  function toggleNode(id) {
    const node = findNode(id);
    if (!node) return;
    node.expanded = node.expanded === false;
    renderMap();
    saveState();
  }

  function getSubtopics(node) {
    return (node.children || []).filter((child) => child.type === 'subtheme');
  }

  function addSection(label) {
    const clean = String(label || '').trim();
    if (!clean) return;
    const node = {id: makeId(`section-${slug(clean)}`), label: clean, type: 'theme', note: '', children: [], expanded: true, meta:{createdBy:'Utilisateur'}};
    state.root.children.push(node);
    selectedNodeId = node.id;
    renderAll();
    toast(`Section « ${clean} » ajoutée.`);
  }

  function askForLabel(message, defaultValue = '') {
    const label = window.prompt(message, defaultValue);
    return label === null ? null : label.trim();
  }

  function addSubtheme(parentId, label) {
    const parent = findNode(parentId);
    if (!parent) return;
    const clean = String(label || '').trim();
    if (!clean) return;
    if (!Array.isArray(parent.children)) parent.children = [];
    const node = {id:makeId(`sub-${slug(clean)}`),label:clean,type:'subtheme',note:'',children:[],expanded:true,meta:{createdBy:'Utilisateur'}};
    parent.children.push(node);
    parent.expanded = true;
    selectedNodeId = node.id;
    renderAll();
    toast(`Sous-section « ${clean} » ajoutée.`);
  }

  function addLeaf(parentId, label) {
    const parent = findNode(parentId);
    if (!parent) return;
    const clean = String(label || '').trim();
    if (!clean) return;
    if (!Array.isArray(parent.children)) parent.children = [];
    const node = {id:makeId(`item-${slug(clean)}`),label:clean,type:'article',note:'',children:[],expanded:true,meta:{createdBy:'Utilisateur'}};
    parent.children.push(node);
    parent.expanded = true;
    const parentParent = findParent(parent.id);
    if (parentParent) parentParent.expanded = true;
    selectedNodeId = node.id;
    renderAll();
    toast(`Étiquette « ${clean} » ajoutée.`);
  }

  function deleteNode(id) {
    const node = findNode(id);
    const parent = findParent(id);
    if (!node || !parent) return;
    if (!window.confirm(`Supprimer « ${node.label} » et tous ses contenus éventuels ?`)) return;
    parent.children = (parent.children || []).filter((child) => child.id !== id);
    selectedNodeId = null;
    renderAll();
    toast('Étiquette supprimée.');
  }

  function expandAll(expanded) {
    allNodes().forEach((node) => { node.expanded = expanded; });
    // The central node is always shown; only its child branches are folded or opened.
    state.root.expanded = true;
    renderMap();
    saveState();
    toast(expanded ? 'Toutes les sections et étiquettes sont ouvertes.' : 'Toutes les sections et étiquettes sont repliées.');
  }

  function exportState() {
    const backup = {...deepClone(state), exportedAt: new Date().toISOString(), exportFormat: 'STUDCORP-MINDMAP-1'};
    const blob = new Blob([JSON.stringify(backup, null, 2)], {type:'application/json;charset=utf-8'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `studcorp-carte-mentale-${new Date().toISOString().slice(0,10)}.json`;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    toast('Copie JSON exportée.');
  }

  function importStateFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const imported = JSON.parse(String(reader.result || '{}'));
        if (!imported.root || !Array.isArray(imported.root.children) || !Array.isArray(imported.legend)) throw new Error('Structure de fichier invalide.');
        if (!window.confirm('Remplacer la carte actuelle par le contenu de ce fichier JSON ?')) return;
        state = imported;
        selectedNodeId = null;
        pendingProposal = null;
        $('#proposalBox').hidden = true;
        renderAll();
        toast('Carte importée et sauvegardée.');
      } catch (error) {
        toast(`Import impossible : ${error.message || 'fichier invalide'}`, 'error');
      } finally {
        $('#importInput').value = '';
      }
    };
    reader.readAsText(file);
  }

  function updateInspectorValue(target, field, value) {
    if (!target) return;
    if (field.startsWith('meta.')) {
      const key = field.slice(5);
      if (!target.meta) target.meta = {};
      target.meta[key] = value;
      return;
    }
    if (field === 'type') {
      if (value !== 'root' && allowedTypes().includes(value)) target.type = value;
      return;
    }
    if (field === 'label' || field === 'note') target[field] = value;
  }

  function onInspectorInput(event) {
    const field = event.target.dataset.inspectorField;
    if (!field || !selectedNodeId) return;
    const target = findNode(selectedNodeId);
    if (!target) return;
    updateInspectorValue(target, field, event.target.value);
    if (field === 'type') renderInspector();
    renderMap();
    saveState();
  }

  function onLegendInput(event) {
    const field = event.target.dataset.legendField;
    if (!field) return;
    const idx = Number(event.target.dataset.legendIndex);
    const item = state.legend[idx];
    if (!item) return;
    if (field === 'color') {
      item.color = safeColor(event.target.value);
      const parent = event.target.closest('.legend-row .legend-color');
      if (parent) parent.style.setProperty('--node-color', item.color);
    } else if (field === 'label') {
      item.label = event.target.value;
    }
    renderMap();
    saveState();
  }

  function addLegendEntry() {
    const label = askForLabel('Nom de la nouvelle entrée de légende :', 'Nouvelle catégorie');
    if (!label) return;
    const type = `custom-${slug(label)}-${Math.random().toString(36).slice(2,5)}`;
    const colors = ['#8ECECE','#D65A0A','#F3A477','#536DFF','#28A745'];
    state.legend.push({type,label,color:colors[state.legend.length % colors.length],description:'Entrée personnalisée'});
    renderLegend();
    renderInspector();
    saveState();
    toast('Entrée ajoutée à la légende. Tu peux l’assigner depuis la fiche d’une étiquette.');
  }

  function removeLegendEntry(type) {
    const item = state.legend.find((x) => x.type === type);
    if (!item) return;
    const structuralType = ['theme','subtheme'].includes(type);
    const impact = structuralType
      ? 'Les sections et sous-sections concernées resteront en place et conserveront leur structure, avec leur couleur par défaut.'
      : type === 'article'
        ? 'Les étiquettes resteront des pages ou articles et utiliseront leur couleur par défaut.'
        : 'Les étiquettes associées seront reclassées dans la catégorie « Page / article ».';
    if (!window.confirm(`Supprimer l’entrée « ${item.label} » de la légende ? ${impact}`)) return;
    state.legend = state.legend.filter((x) => x.type !== type);
    if (!structuralType && type !== 'article') {
      allNodes().forEach((node) => { if (node.type === type) node.type = 'article'; });
    }
    renderAll();
    toast(`Entrée « ${item.label} » supprimée de la légende.`);
  }

  function updateAIMode() {
    const mode = $('#aiMode');
    if (!mode) return;
    const base = (aiConfig.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const isDefaultOpenAI = base === 'https://api.openai.com/v1';
    if (aiConfig.apiKey && aiConfig.apiKey.trim()) {
      mode.classList.add('connected');
      mode.textContent = `IA connectée · clé stockée dans ce navigateur`;
    } else if (!isDefaultOpenAI) {
      mode.classList.add('connected');
      mode.textContent = `Proxy IA configuré · ${aiConfig.model || 'modèle du proxy'}`;
    } else {
      mode.classList.remove('connected');
      mode.textContent = 'Mode local · configure un proxy IA pour le langage libre';
    }
  }

  function compactMap() {
    const walk = (node, path = []) => ({
      id: node.id,
      label: node.label,
      type: node.type,
      path: [...path, node.label].join(' > '),
      note: node.note || '',
      meta: Object.fromEntries(['query','currentCategory','audience','url','remark','searchVolume','publicationDate','sourceTheme','sourceRow'].filter((k) => node.meta && node.meta[k]).map((k) => [k,node.meta[k]])),
      children: (node.children || []).map((child) => walk(child, [...path,node.label]))
    });
    return {root: walk(state.root), legend: state.legend.map(({type,label,color}) => ({type,label,color}))};
  }

  const SYSTEM_PROMPT = `Tu es l'agent éditorial et SEO de STUDCORP. Tu aides à organiser la carte mentale d'un blog qui s'adresse aux étudiants français et internationaux. Tu dois préserver les contenus existants et ne jamais supprimer ou renommer des nœuds sans demande explicite. Propose une organisation claire, maintiens les sujets proches ensemble, conserve les libellés et métadonnées utiles, et respecte la direction artistique existante : bleu pétrole #2F6674, turquoise #4AA6B6 / #8ECECE, vert #28A745, orange #D65A0A et pêche #F3A477.\n\nRetourne UNIQUEMENT un objet JSON valide, sans Markdown, selon ce schéma : {"summary":"résumé bref de la proposition","rationale":"raisonnement éditorial bref","actions":[...]}. Types d'actions autorisés : {"type":"add_section","label":"...","note":"..."}; {"type":"add_subsection","parentId":"ID de section existant","label":"...","note":"..."}; {"type":"add_node","parentId":"ID existant","label":"...","nodeType":"article|page|hub|volume|subtheme|...","note":"...","meta":{"query":"..."}}; {"type":"update_node","targetId":"ID existant","label":"...","note":"...","nodeType":"...","meta":{"remark":"..."}}; {"type":"move_node","targetId":"ID existant","newParentId":"ID existant"}; {"type":"remove_node","targetId":"ID existant"}; {"type":"update_legend","items":[{"type":"type existant ou nouveau","label":"...","color":"#RRGGBB"}]}. Les propriétés non nécessaires peuvent être omises. Pour créer une section, privilégie une couleur/typologie existante. Pour une proposition de légende, conserve une palette harmonieuse et un contraste lisible. Pour déplacer des nœuds, réutilise les ID exacts du snapshot. Ne produis pas de texte avant/après le JSON. Si aucune modification n'est nécessaire, retourne actions: [].`;

  function parseJsonResponse(text) {
    const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try { return JSON.parse(cleaned); } catch (_) {
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
      throw new Error('La réponse de l’agent n’est pas un JSON exploitable. Réessaie avec une demande plus précise.');
    }
  }

  function findByLabel(label) {
    const wanted = String(label || '').trim().toLocaleLowerCase('fr');
    if (!wanted) return null;
    return allNodes().find((node) => String(node.label || '').trim().toLocaleLowerCase('fr') === wanted) ||
      allNodes().find((node) => String(node.label || '').toLocaleLowerCase('fr').includes(wanted));
  }

  function localProposal(prompt) {
    const text = String(prompt || '').trim();
    const lower = text.toLocaleLowerCase('fr');
    const actions = [];
    let summary = 'Aucune modification préparée en mode local.';
    let rationale = 'Le mode local sait proposer quelques opérations simples. Pour analyser librement les contenus et élaborer des réorganisations plus complexes, configure une API IA dans les paramètres.';
    const secMatch = text.match(/(?:ajoute|ajouter|crée|créer|création)\s+(?:moi\s+)?(?:une\s+)?(?:nouvelle\s+)?section\s+(?:intitulée?\s+)?[«"']?(.+?)[»"']?\s*$/i) ||
      text.match(/(?:section)\s+[«"'](.+?)[»"']/i);
    if (secMatch && secMatch[1]) {
      const label = secMatch[1].replace(/[»"']+$/,'').trim();
      actions.push({type:'add_section', label, note:'Section proposée en mode local à partir de la demande utilisateur.'});
      summary = `Ajouter une section « ${label} » à la carte.`;
      rationale = 'La section sera créée au niveau racine, dans la même famille visuelle que les autres thématiques.';
      return {summary,rationale,actions,localMode:true};
    }
    const subMatch = text.match(/(?:ajoute|ajouter|crée|créer|propose)\s+(?:moi\s+)?(?:une\s+)?(?:nouvelle\s+)?(?:sous-section|sous-thématique|sous-thème)\s+[«"']?(.+?)[»"']?\s+(?:dans|sous|au sein de)\s+[«"']?(.+?)[»"']?\s*$/i);
    if (subMatch) {
      const label = subMatch[1].replace(/[»"']+$/,'').trim();
      const parentLabel = subMatch[2].replace(/[»"']+$/,'').trim();
      const parent = findByLabel(parentLabel);
      if (parent) {
        actions.push({type:'add_subsection',parentId:parent.id,label,note:'Sous-section proposée en mode local.'});
        summary = `Ajouter « ${label} » sous « ${parent.label} ».`;
        rationale = 'La sous-section sera insérée dans la branche existante trouvée dans la carte.';
      } else {
        rationale = `Je n’ai pas trouvé de branche correspondant à « ${parentLabel} ». Précise le libellé exact de la section.`;
      }
      return {summary,rationale,actions,localMode:true};
    }
    if (lower.includes('légende') || lower.includes('legende')) {
      actions.push({type:'update_legend',items:state.legend.filter((x) => ['theme','subtheme','volume','page','hub','article'].includes(x.type)).map((x) => ({type:x.type,label:x.label,color:x.color}))});
      summary = 'Prévisualiser les entrées actuelles de la légende et leur palette STUDCORP.';
      rationale = 'La palette existante est déjà cohérente avec l’identité visuelle. Ce mode local peut la réappliquer, mais ne peut pas interpréter une demande de création complexe.';
      return {summary,rationale,actions,localMode:true};
    }
    const addNodeMatch = text.match(/(?:ajoute|ajouter|crée|créer)\s+(?:moi\s+)?(?:une\s+)?(?:étiquette|article|mot-clé|mot cle)\s+[«"']?(.+?)[»"']?\s+(?:dans|sous|à)\s+[«"']?(.+?)[»"']?\s*$/i);
    if (addNodeMatch) {
      const label = addNodeMatch[1].replace(/[»"']+$/,'').trim();
      const parentLabel = addNodeMatch[2].replace(/[»"']+$/,'').trim();
      const parent = findByLabel(parentLabel);
      if (parent) {
        actions.push({type:'add_node',parentId:parent.id,label,nodeType:'article',note:'Étiquette créée en mode local.'});
        summary = `Ajouter l’étiquette « ${label} » sous « ${parent.label} ».`;
        rationale = 'L’étiquette sera modifiable depuis sa fiche après validation.';
      } else {
        rationale = `Je n’ai pas trouvé « ${parentLabel} » dans la carte. Essaie avec le nom exact de la section ou de la sous-section.`;
      }
      return {summary,rationale,actions,localMode:true};
    }
    return {summary,rationale,actions,localMode:true};
  }

  async function requestAI(prompt) {
    const base = (aiConfig.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/,'');
    const hasKey = Boolean(aiConfig.apiKey && aiConfig.apiKey.trim());
    const isDefaultOpenAI = base === 'https://api.openai.com/v1';
    if (!hasKey && isDefaultOpenAI) return localProposal(prompt);
    const snapshot = compactMap();
    const userMessage = `DEMANDE UTILISATEUR\n${prompt}\n\nÉTAT ACTUEL DE LA CARTE (IDs inclus)\n${JSON.stringify(snapshot)}${pendingProposal ? `\n\nPROPOSITION PRÉCÉDENTE À AJUSTER (ne l'applique pas, propose une nouvelle version)\n${JSON.stringify(pendingProposal)}` : ''}`;
    const headers = {'Content-Type':'application/json'};
    if (hasKey) headers.Authorization = `Bearer ${aiConfig.apiKey}`;
    const response = await fetch(`${base}/chat/completions`, {
      method:'POST',
      headers,
      body:JSON.stringify({
        model:aiConfig.model || 'gpt-4o-mini',
        temperature:0.35,
        response_format:{type:'json_object'},
        messages:[{role:'system',content:SYSTEM_PROMPT},{role:'user',content:userMessage}]
      })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = body && body.error && body.error.message ? body.error.message : `Erreur API (${response.status}).`;
      throw new Error(message);
    }
    const content = body && body.choices && body.choices[0] && body.choices[0].message ? body.choices[0].message.content : '';
    const proposal = parseJsonResponse(content);
    if (!Array.isArray(proposal.actions)) proposal.actions = [];
    proposal.summary = String(proposal.summary || 'Proposition prête à examiner.');
    proposal.rationale = String(proposal.rationale || '');
    proposal.localMode = false;
    return proposal;
  }

  function addChatMessage(role, content) {
    const message = document.createElement('div');
    if (role === 'user') {
      message.className = 'chat-message user-message';
      message.innerHTML = `<p>${html(content)}</p>`;
    } else {
      message.className = 'chat-message assistant-message';
      message.innerHTML = `<span class="chat-avatar">✦</span><div><strong>${role === 'error' ? 'Problème rencontré' : 'Agent'}</strong><p>${html(content)}</p></div>`;
      if (role === 'error') message.classList.add('error-message');
    }
    $('#aiChat').appendChild(message);
    $('#aiChat').scrollTop = $('#aiChat').scrollHeight;
  }

  function actionDescription(action) {
    const byId = (id) => findNode(id);
    const target = byId(action.targetId);
    const parent = byId(action.parentId);
    const newParent = byId(action.newParentId);
    switch (action.type) {
      case 'add_section': return `<strong>Ajouter une section</strong> : ${html(action.label || 'Nouvelle section')}`;
      case 'add_subsection': return `<strong>Ajouter une sous-section</strong> : ${html(action.label || '')}${parent ? ` <span>dans « ${html(parent.label)} »</span>` : ''}`;
      case 'add_node': return `<strong>Ajouter une étiquette</strong> : ${html(action.label || '')}${parent ? ` <span>sous « ${html(parent.label)} »</span>` : ''}`;
      case 'update_node': return `<strong>Modifier</strong> : ${html(target ? target.label : action.targetId || 'étiquette')} ${action.label ? `→ « ${html(action.label)} »` : ''}`;
      case 'move_node': return `<strong>Déplacer</strong> : ${html(target ? target.label : action.targetId || '')}${newParent ? ` <span>vers « ${html(newParent.label)} »</span>` : ''}`;
      case 'remove_node': return `<strong>Supprimer</strong> : ${html(target ? target.label : action.targetId || '')}`;
      case 'update_legend': return `<strong>Modifier la légende</strong> : ${Array.isArray(action.items) ? action.items.length : 0} entrée(s) proposée(s)`;
      default: return `<strong>Action inconnue</strong> : ${html(action.type || 'sans type')}`;
    }
  }

  function renderProposal(proposal) {
    pendingProposal = proposal;
    const box = $('#proposalBox');
    const actions = Array.isArray(proposal.actions) ? proposal.actions : [];
    box.hidden = false;
    box.innerHTML = `
      <div class="proposal-head"><h3>Proposition à valider</h3><span class="leaf-badge">${actions.length} action(s)</span></div>
      <p class="proposal-summary">${html(proposal.summary || 'Proposition de modification.')}</p>
      ${proposal.rationale ? `<p class="proposal-summary">${html(proposal.rationale)}</p>` : ''}
      ${proposal.localMode ? '<p class="proposal-summary"><strong>Mode local :</strong> ces règles simples ne remplacent pas une IA générative. Configure une API pour les demandes de rédaction ou de réorganisation complexes.</p>' : ''}
      <div class="proposal-actions">${actions.length ? actions.map((a) => `<div class="proposal-action">${actionDescription(a)}</div>`).join('') : '<div class="proposal-action">Aucune action à appliquer pour le moment.</div>'}</div>
      <div class="proposal-footer">
        <button class="button button-primary" type="button" data-action="accept-proposal" ${actions.length ? '' : 'disabled'}>Accepter & appliquer</button>
        <button class="button button-soft" type="button" data-action="reject-proposal">Refuser</button>
      </div>`;
    $('#proposalHint').textContent = actions.length ? 'La proposition attend ton accord.' : 'Aucune modification à valider.';
    $('#aiChat').scrollTop = $('#aiChat').scrollHeight;
  }

  async function onAskAI(event) {
    event.preventDefault();
    if (busyAI) return;
    const prompt = $('#aiPrompt').value.trim();
    if (!prompt) return;
    lastAskedPrompt = prompt;
    addChatMessage('user', prompt);
    $('#aiPrompt').value = '';
    busyAI = true;
    const btn = $('#askAIBtn');
    btn.disabled = true;
    btn.innerHTML = 'Préparation…';
    try {
      const proposal = await requestAI(prompt);
      renderProposal(proposal);
      const summary = proposal.actions && proposal.actions.length ? `${proposal.summary} ${proposal.actions.length} modification(s) proposée(s), en attente de validation.` : `${proposal.summary} ${proposal.rationale || ''}`;
      addChatMessage('assistant', summary.trim());
    } catch (error) {
      addChatMessage('error', `${error.message || 'Erreur inconnue.'} Vérifie la clé, le modèle, l’URL et les droits d’accès du fournisseur. Si l’API bloque les appels depuis le navigateur, utilise un proxy serveur sécurisé.`);
      toast('L’agent IA n’a pas pu répondre.', 'error');
    } finally {
      busyAI = false;
      btn.disabled = false;
      btn.innerHTML = 'Proposer <span aria-hidden="true">↗</span>';
    }
  }

  function resolveTarget(action) {
    return (action.targetId && findNode(action.targetId)) || findByLabel(action.targetLabel || action.target || '');
  }

  function createNodeForAction(action, kind) {
    const label = String(action.label || '').trim();
    if (!label) return null;
    const type = action.nodeType || (kind === 'section' ? 'theme' : kind === 'subsection' ? 'subtheme' : 'article');
    return {id:makeId(`${kind}-${slug(label)}`),label,type:allowedTypes().includes(type) ? type : (kind === 'section' ? 'theme' : kind === 'subsection' ? 'subtheme' : 'article'),note:String(action.note || ''),children:[],expanded:true,meta:action.meta && typeof action.meta === 'object' ? action.meta : {createdBy:'Agent IA'}};
  }

  function applyAction(action) {
    if (!action || typeof action !== 'object') return 'Action ignorée.';
    if (action.type === 'add_section') {
      const node = createNodeForAction(action,'section');
      if (!node) return 'Section ignorée : titre manquant.';
      state.root.children.push(node);
      selectedNodeId = node.id;
      return `Section ajoutée : ${node.label}`;
    }
    if (action.type === 'add_subsection') {
      const parent = findNode(action.parentId) || findByLabel(action.parentLabel || '');
      const node = createNodeForAction(action,'subsection');
      if (!parent || !node) return 'Sous-section ignorée : parent ou titre introuvable.';
      if (!Array.isArray(parent.children)) parent.children = [];
      parent.children.push(node); parent.expanded = true;
      selectedNodeId = node.id;
      return `Sous-section ajoutée : ${node.label}`;
    }
    if (action.type === 'add_node') {
      const parent = findNode(action.parentId) || findByLabel(action.parentLabel || '');
      const node = createNodeForAction(action,'node');
      if (!parent || !node) return 'Étiquette ignorée : parent ou titre introuvable.';
      if (!Array.isArray(parent.children)) parent.children = [];
      parent.children.push(node); parent.expanded = true;
      const parentParent = findParent(parent.id); if (parentParent) parentParent.expanded = true;
      selectedNodeId = node.id;
      return `Étiquette ajoutée : ${node.label}`;
    }
    if (action.type === 'update_node') {
      const node = resolveTarget(action);
      if (!node) return `Modification ignorée : nœud introuvable (${action.targetId || action.targetLabel || ''}).`;
      if (action.label !== undefined) node.label = String(action.label);
      if (action.note !== undefined) node.note = String(action.note);
      if (action.nodeType && allowedTypes().includes(action.nodeType)) node.type = action.nodeType;
      if (action.meta && typeof action.meta === 'object') node.meta = {...(node.meta || {}), ...action.meta};
      selectedNodeId = node.id;
      return `Étiquette modifiée : ${node.label}`;
    }
    if (action.type === 'move_node') {
      const node = resolveTarget(action);
      const oldParent = node ? findParent(node.id) : null;
      const newParent = findNode(action.newParentId) || findByLabel(action.newParentLabel || '');
      if (!node || !oldParent || !newParent || node.id === state.root.id || node.id === newParent.id) return 'Déplacement ignoré : nœud ou destination introuvable.';
      if (allNodes(node).some((item) => item.id === newParent.id)) return 'Déplacement ignoré : impossible de déplacer un nœud dans son propre descendant.';
      oldParent.children = oldParent.children.filter((child) => child.id !== node.id);
      if (!Array.isArray(newParent.children)) newParent.children = [];
      newParent.children.push(node); newParent.expanded = true;
      selectedNodeId = node.id;
      return `Déplacement effectué : ${node.label}`;
    }
    if (action.type === 'remove_node') {
      const node = resolveTarget(action);
      const parent = node ? findParent(node.id) : null;
      if (!node || !parent) return 'Suppression ignorée : nœud introuvable.';
      parent.children = parent.children.filter((child) => child.id !== node.id);
      if (selectedNodeId === node.id) selectedNodeId = null;
      return `Nœud supprimé : ${node.label}`;
    }
    if (action.type === 'update_legend') {
      if (!Array.isArray(action.items)) return 'Légende ignorée : liste invalide.';
      action.items.forEach((suggested) => {
        if (!suggested || !suggested.type) return;
        const existing = state.legend.find((entry) => entry.type === suggested.type);
        const normalizedColor = safeColor(suggested.color || (existing && existing.color) || '#4AA6B6');
        if (existing) {
          if (suggested.label) existing.label = String(suggested.label);
          existing.color = normalizedColor;
        } else {
          state.legend.push({type:String(suggested.type),label:String(suggested.label || suggested.type),color:normalizedColor,description:'Entrée ajoutée par l’agent IA'});
        }
      });
      return 'Légende mise à jour.';
    }
    return `Type d’action inconnu : ${action.type || '(sans type)'}`;
  }

  function acceptProposal() {
    if (!pendingProposal || !Array.isArray(pendingProposal.actions) || !pendingProposal.actions.length) return;
    const actions = pendingProposal.actions;
    const results = [];
    actions.forEach((action) => results.push(applyAction(action)));
    const summary = pendingProposal.summary || 'Proposition appliquée.';
    pendingProposal = null;
    $('#proposalBox').hidden = true;
    renderAll();
    addChatMessage('assistant', `Proposition appliquée. ${summary}`);
    toast(`${results.filter((x) => !x.includes('ignorée')).length} action(s) appliquée(s).`);
  }

  function rejectProposal() {
    pendingProposal = null;
    $('#proposalBox').hidden = true;
    $('#proposalHint').textContent = 'Proposition refusée. La carte n’a pas été modifiée.';
    addChatMessage('assistant', 'D’accord, je n’ai rien appliqué. Tu peux préciser une autre organisation dans le champ ci-dessous.');
    toast('Proposition refusée : la carte reste inchangée.');
  }

  // Delegated interactions.
  document.addEventListener('click', (event) => {
    if (mapView.suppressClick) {
      mapView.suppressClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const select = event.target.closest('[data-select-id]');
    const actionEl = event.target.closest('[data-action]');
    if (actionEl) {
      const action = actionEl.dataset.action;
      const id = actionEl.dataset.nodeId;
      const parentId = actionEl.dataset.parentId;
      if (action === 'toggle-node') { toggleNode(id); return; }
      if (action === 'add-subtheme') {
        const label = askForLabel('Nom de la sous-section à ajouter :');
        if (label) addSubtheme(parentId, label);
        return;
      }
      if (action === 'add-leaf') {
        const label = askForLabel('Titre de la nouvelle étiquette :');
        if (label) addLeaf(parentId, label);
        return;
      }
      if (action === 'delete-node') { deleteNode(id); return; }
      if (action === 'copy-node-link') {
        const node = findNode(id);
        const text = node && node.meta && node.meta.url && linkIsValid(node.meta.url) ? node.meta.url : (node ? node.label : '');
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => toast('Lien ou titre copié.')).catch(() => toast(text));
        else toast(text);
        return;
      }
      if (action === 'remove-legend') { removeLegendEntry(actionEl.dataset.legendType); return; }
      if (action === 'accept-proposal') { acceptProposal(); return; }
      if (action === 'reject-proposal') { rejectProposal(); return; }
    }
    if (select) {
      selectedNodeId = select.dataset.selectId;
      renderInspector();
      renderMap();
      return;
    }
  });

  document.addEventListener('input', (event) => {
    if (event.target.dataset.inspectorField) { onInspectorInput(event); return; }
    if (event.target.dataset.legendField) { onLegendInput(event); return; }
    if (event.target.id === 'searchInput') {
      searchTerm = event.target.value.trim().toLocaleLowerCase('fr');
      renderMap();
    }
  });

  document.addEventListener('change', (event) => {
    if (event.target.dataset.inspectorField && event.target.dataset.inspectorField === 'type') {
      renderInspector(); renderMap(); saveState();
    }
  });

  document.addEventListener('keydown', (event) => {
    const editingText = event.target.matches('input, textarea, select, [contenteditable="true"]');
    if ((event.metaKey || event.ctrlKey) && !editingText && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) redoChange(); else undoChange();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && !editingText && event.key.toLowerCase() === 'y') {
      event.preventDefault(); redoChange(); return;
    }
    if (event.target.matches('[data-select-id]') && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      event.target.click();
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault(); $('#searchInput').focus();
    }
    if (event.key === 'Escape' && document.activeElement === $('#searchInput')) {
      $('#searchInput').value = ''; searchTerm = ''; renderMap();
    }
  });

  $('#refreshBtn').addEventListener('click', () => {
    flushSave();
    window.location.reload();
  });
  $('#undoBtn').addEventListener('click', undoChange);
  $('#redoBtn').addEventListener('click', redoChange);
  $('#collapseAllBtn').addEventListener('click', () => expandAll(false));
  $('#expandAllBtn').addEventListener('click', () => expandAll(true));
  $('#addSectionBtn').addEventListener('click', () => {
    const label = askForLabel('Nom de la nouvelle section principale :');
    if (label) addSection(label);
  });
  $('#addLegendBtn').addEventListener('click', addLegendEntry);
  $('#exportBtn').addEventListener('click', exportState);
  $('#importBtn').addEventListener('click', () => $('#importInput').click());
  $('#importInput').addEventListener('change', (event) => importStateFile(event.target.files && event.target.files[0]));
  $('#clearSelectionBtn').addEventListener('click', () => { selectedNodeId = null; renderInspector(); renderMap(); });
  $('#toggleAIPanel').addEventListener('click', () => {
    $('#aiPanel').scrollIntoView({behavior:'smooth',block:'center'});
    $('#aiPanel').classList.add('ai-highlight');
    setTimeout(() => $('#aiPanel').classList.remove('ai-highlight'), 1200);
  });
  $('#aiSettingsToggle').addEventListener('click', () => { $('#aiSettings').hidden = !$('#aiSettings').hidden; });
  $('#saveAISettingsBtn').addEventListener('click', () => {
    aiConfig = {
      baseUrl: ($('#apiBaseInput').value.trim() || 'https://api.openai.com/v1'),
      model: ($('#apiModelInput').value.trim() || 'gpt-4o-mini'),
      apiKey: $('#apiKeyInput').value.trim(),
      syncUrl: normalizedWorkerUrl($('#syncUrlInput').value)
    };
    $('#syncUrlInput').value = aiConfig.syncUrl;
    localStorage.setItem(AI_CONFIG_KEY, JSON.stringify(aiConfig));
    updateAIMode();
    if (aiConfig.syncUrl) startSharedSync();
    else {
      clearInterval(syncPollTimer);
      syncPollTimer = null;
      syncReady = false;
      syncBaseState = null;
      setSaveStatus('Enregistré sur cet appareil');
    }
    toast(aiConfig.apiKey ? 'Paramètres IA enregistrés dans ce navigateur.' : (aiConfig.syncUrl ? 'Paramètres enregistrés ; connexion au stockage partagé en cours.' : 'Mode local activé : aucune clé API enregistrée.'));
    $('#aiSettings').hidden = true;
  });
  $('#clearAIKeyBtn').addEventListener('click', () => {
    aiConfig.apiKey = '';
    $('#apiKeyInput').value = '';
    localStorage.setItem(AI_CONFIG_KEY, JSON.stringify(aiConfig));
    updateAIMode();
    toast('Clé API effacée du navigateur.');
  });
  $('#aiForm').addEventListener('submit', onAskAI);
  initMapNavigation();
  window.addEventListener('resize', () => requestAnimationFrame(() => {
    const stage = $('#mapStage');
    if (!stage) return;
    if (!mapView.initialized) {
      mapView.initialized = true;
      centerMapOnRoot(getResponsiveInitialScale());
    } else {
      const previousWidth = mapView.lastStageWidth || stage.clientWidth;
      const previousHeight = mapView.lastStageHeight || stage.clientHeight;
      mapView.x += (stage.clientWidth - previousWidth) / 2;
      mapView.y += (stage.clientHeight - previousHeight) / 2;
      rememberMapViewportSize(stage);
      updateMapTransform();
    }
    drawConnectors();
  }));
  window.addEventListener('pagehide', () => { flushSave(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSave(); });

  // Initialisation.
  try {
    state = loadState();
    ensureMapLayout();
    loadAIConfig();
    resetHistory();
    renderAll();
    if (aiConfig.syncUrl) startSharedSync();
  } catch (error) {
    document.body.innerHTML = `<main style="font:16px system-ui;padding:30px;color:#244e58"><h1>Impossible d’ouvrir la carte</h1><p>${html(error.message || error)}</p><p>Vérifie que <code>index.html</code>, <code>styles.css</code>, <code>data.js</code> et <code>app.js</code> se trouvent dans le même dossier.</p></main>`;
  }
})();
