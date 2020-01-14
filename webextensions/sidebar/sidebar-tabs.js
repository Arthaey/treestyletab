/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import {
  log as internalLogger,
  wait,
  configs
} from '/common/common.js';

import * as Constants from '/common/constants.js';
import * as ApiTabs from '/common/api-tabs.js';
import * as TabsStore from '/common/tabs-store.js';
import * as TabsInternalOperation from '/common/tabs-internal-operation.js';
import * as TabsUpdate from '/common/tabs-update.js';
import { SequenceMatcher } from '/common/diff.js';

import Tab from '/common/Tab.js';
import Window from '/common/Window.js';

import * as BackgroundConnection from './background-connection.js';
import * as CollapseExpand from './collapse-expand.js';

import EventListenerManager from '/extlib/EventListenerManager.js';

import {
  kTAB_ELEMENT_NAME,
  TabInvalidationTarget,
  TabUpdateTarget,
} from './components/TabElement.js';

function log(...args) {
  internalLogger('sidebar/sidebar-tabs', ...args);
}

let mPromisedInitializedResolver;
let mPromisedInitialized = new Promise((resolve, _reject) => {
  mPromisedInitializedResolver = resolve;
});

export const wholeContainer = document.querySelector('#all-tabs');

export const onSyncFailed = new EventListenerManager();

export function init() {
  document.querySelector('#sync-throbber').addEventListener('animationiteration', synchronizeThrobberAnimation);

  document.documentElement.setAttribute(Constants.kLABEL_OVERFLOW, configs.labelOverflowStyle);

  mPromisedInitializedResolver();
  mPromisedInitialized = mPromisedInitializedResolver = null;
}

export function getTabFromDOMNode(node, options = {}) {
  if (typeof options != 'object')
    options = {};
  if (!node)
    return null;
  if (!(node instanceof Element))
    node = node.parentNode;
  const tab = node && node.closest('.tab');
  if (options.force)
    return tab && tab.apiTab;
  return TabsStore.ensureLivingTab(tab && tab.apiTab);
}


async function reserveToUpdateLoadingState() {
  if (mPromisedInitialized)
    await mPromisedInitialized;
  if (reserveToUpdateLoadingState.waiting)
    clearTimeout(reserveToUpdateLoadingState.waiting);
  reserveToUpdateLoadingState.waiting = setTimeout(() => {
    delete reserveToUpdateLoadingState.waiting;
    updateLoadingState();
  }, 0);
}

function updateLoadingState() {
  document.documentElement.classList.toggle(Constants.kTABBAR_STATE_HAVE_LOADING_TAB, Tab.hasLoadingTab(TabsStore.getWindow()));
}

async function synchronizeThrobberAnimation() {
  let processedCount = 0;
  for (const tab of Tab.getNeedToBeSynchronizedTabs(TabsStore.getWindow(), { iterator: true })) {
    tab.$TST.removeState(Constants.kTAB_STATE_THROBBER_UNSYNCHRONIZED);
    TabsStore.removeUnsynchronizedTab(tab);
    processedCount++;
  }
  if (processedCount == 0)
    return;

  document.documentElement.classList.add(Constants.kTABBAR_STATE_THROBBER_SYNCHRONIZING);
  void document.documentElement.offsetWidth;
  document.documentElement.classList.remove(Constants.kTABBAR_STATE_THROBBER_SYNCHRONIZING);
}



export function updateAll() {
  updateLoadingState();
  synchronizeThrobberAnimation();
  // We need to update from bottom to top, because
  // TabUpdateTarget.DescendantsHighlighted refers results of descendants.
  for (const tab of Tab.getAllTabs(TabsStore.getWindow(), { iterator: true, reverse: true })) {
    tab.$TST.invalidateElement(TabInvalidationTarget.Twisty | TabInvalidationTarget.CloseBox | TabInvalidationTarget.Tooltip);
    tab.$TST.updateElement(TabUpdateTarget.Counter | TabUpdateTarget.DescendantsHighlighted);
    if (!tab.$TST.collapsed)
      tab.$TST.element.updateOverflow();
  }
}



export function reserveToSyncTabsOrder() {
  if (configs.delayToRetrySyncTabsOrder <= 0) {
    syncTabsOrder();
    return;
  }
  if (reserveToSyncTabsOrder.timer)
    clearTimeout(reserveToSyncTabsOrder.timer);
  reserveToSyncTabsOrder.timer = setTimeout(() => {
    delete reserveToSyncTabsOrder.timer;
    syncTabsOrder();
  }, configs.delayToRetrySyncTabsOrder);
}
reserveToSyncTabsOrder.retryCount = 0;

async function syncTabsOrder() {
  log('syncTabsOrder');
  const windowId      = TabsStore.getWindow();
  const [internalOrder, nativeOrder] = await Promise.all([
    browser.runtime.sendMessage({
      type: Constants.kCOMMAND_PULL_TABS_ORDER,
      windowId
    }).catch(ApiTabs.createErrorHandler()),
    browser.tabs.query({ windowId }).then(tabs => tabs.map(tab => tab.id))
  ]);

  const trackedWindow = TabsStore.windows.get(windowId);
  const actualOrder   = trackedWindow.order;
  const container     = trackedWindow.element;
  const elementsOrder = Array.from(container.childNodes, tab => tab.apiTab.id);

  log('syncTabsOrder: ', { internalOrder, nativeOrder, actualOrder, elementsOrder });

  if (internalOrder.join('\n') == elementsOrder.join('\n') &&
      internalOrder.join('\n') == actualOrder.join('\n') &&
      internalOrder.join('\n') == nativeOrder.join('\n')) {
    reserveToSyncTabsOrder.retryCount = 0;
    return; // no need to sync
  }

  const expectedTabs = internalOrder.slice(0).sort().join('\n');
  const nativeTabs   = nativeOrder.slice(0).sort().join('\n');
  if (expectedTabs != nativeTabs) {
    console.log(`Fatal error: native tabs are not same to the tabs tracked by the master process, for the window ${windowId}. Reloading all...`);
    reserveToSyncTabsOrder.retryCount = 0;
    browser.runtime.sendMessage({
      type: Constants.kCOMMAND_RELOAD,
      all:  true
    }).catch(ApiTabs.createErrorSuppressor());
    return;
  }

  const actualTabs = actualOrder.slice(0).sort().join('\n');
  if (expectedTabs != actualTabs ||
      elementsOrder.length != internalOrder.length) {
    if (reserveToSyncTabsOrder.retryCount > 10) {
      console.log(`Error: tracked tabs are not same to pulled tabs, for the window ${windowId}. Rebuilding...`);
      reserveToSyncTabsOrder.retryCount = 0;
      return onSyncFailed.dispatch();
    }
    log('syncTabsOrder: retry');
    reserveToSyncTabsOrder.retryCount++;
    return reserveToSyncTabsOrder();
  }
  reserveToSyncTabsOrder.retryCount = 0;

  trackedWindow.order = internalOrder;
  let count = 0;
  for (const tab of trackedWindow.getOrderedTabs()) {
    tab.index = count++;
    tab.reindexedBy = `syncTabsOrder (${tab.index})`;
  }

  const DOMElementsOperations = (new SequenceMatcher(elementsOrder, internalOrder)).operations();
  log(`syncTabsOrder: rearrange `, { internalOrder:internalOrder.join(','), elementsOrder:elementsOrder.join(',') });
  for (const operation of DOMElementsOperations) {
    const [tag, fromStart, fromEnd, toStart, toEnd] = operation;
    log('syncTabsOrder: operation ', { tag, fromStart, fromEnd, toStart, toEnd });
    switch (tag) {
      case 'equal':
      case 'delete':
        break;

      case 'insert':
      case 'replace':
        const moveTabIds = internalOrder.slice(toStart, toEnd);
        const referenceTab = fromStart < elementsOrder.length ? Tab.get(elementsOrder[fromStart]) : null;
        log(`syncTabsOrder: move ${moveTabIds.join(',')} before `, referenceTab);
        for (const id of moveTabIds) {
          const tab = Tab.get(id);
          if (tab)
            tab.$TST.element.parentNode.insertBefore(tab.$TST.element, referenceTab && referenceTab.$TST.element);
        }
        break;
    }
  }

  // Tabs can be moved while processing by other addons like Simple Tab Groups,
  // so resync until they are completely synchronized.
  reserveToSyncTabsOrder();
}

Window.onInitialized.addListener(windowId => {
  let container = document.getElementById(`window-${windowId}`);
  if (!container) {
    container = document.createElement('ul');
    wholeContainer.appendChild(container);
  }
  container.dataset.windowId = windowId;
  container.setAttribute('id', `window-${windowId}`);
  container.classList.add('tabs');
  container.$TST = TabsStore.windows.get(windowId);
  container.$TST.bindElement(container);
});

Tab.onInitialized.addListener((tab, _info) => {
  if (tab.$TST.element) // restored from cache
    return;

  const id = `tab-${tab.id}`;
  let tabElement = document.getElementById(id);
  if (tabElement) {
    tab.$TST.bindElement(tabElement);
    return;
  }

  tabElement = document.createElement(kTAB_ELEMENT_NAME);
  tab.$TST.bindElement(tabElement);

  tab.$TST.setAttribute('id', id);
  tab.$TST.setAttribute(Constants.kAPI_TAB_ID, tab.id || -1);
  tab.$TST.setAttribute(Constants.kAPI_WINDOW_ID, tab.windowId || -1);

  const label = document.createElement('span');
  label.classList.add(Constants.kLABEL);
  const labelContent = label.appendChild(document.createElement('span'));
  labelContent.classList.add(`${Constants.kLABEL}-content`);
  tabElement.appendChild(label);

  const twisty = document.createElement('span');
  twisty.classList.add(Constants.kTWISTY);
  twisty.setAttribute('title', browser.i18n.getMessage('tab_twisty_collapsed_tooltip'));
  tabElement.insertBefore(twisty, label);

  const favicon = document.createElement('span');
  favicon.classList.add(Constants.kFAVICON);
  const faviconImage = favicon.appendChild(document.createElement('img'));
  faviconImage.classList.add(Constants.kFAVICON_IMAGE);
  const defaultIcon = favicon.appendChild(document.createElement('span'));
  defaultIcon.classList.add(Constants.kFAVICON_BUILTIN);
  defaultIcon.classList.add(Constants.kFAVICON_DEFAULT); // just for backward compatibility, and this should be removed from future versions
  const throbber = favicon.appendChild(document.createElement('span'));
  throbber.classList.add(Constants.kTHROBBER);
  tabElement.insertBefore(favicon, label);

  const counter = document.createElement('span');
  counter.classList.add(Constants.kCOUNTER);
  tabElement.appendChild(counter);

  const soundButton = document.createElement('button');
  soundButton.classList.add(Constants.kSOUND_BUTTON);
  tabElement.appendChild(soundButton);

  const closebox = document.createElement('span');
  closebox.classList.add(Constants.kCLOSEBOX);
  closebox.setAttribute('title', browser.i18n.getMessage('tab_closebox_tab_tooltip'));
  closebox.setAttribute('draggable', true); // this is required to cancel click by dragging
  tabElement.appendChild(closebox);

  const burster = document.createElement('span');
  burster.classList.add(Constants.kBURSTER);
  tabElement.appendChild(burster);

  const activeMarker = document.createElement('span');
  activeMarker.classList.add(Constants.kHIGHLIGHTER);
  tabElement.appendChild(activeMarker);

  const identityMarker = document.createElement('span');
  identityMarker.classList.add(Constants.kCONTEXTUAL_IDENTITY_MARKER);
  tabElement.appendChild(identityMarker);

  const leftEdge = document.createElement('span');
  leftEdge.classList.add('left-edge');
  tabElement.appendChild(leftEdge);

  const extraItemsContainerBehind = document.createElement('span');
  extraItemsContainerBehind.classList.add(Constants.kEXTRA_ITEMS_CONTAINER);
  extraItemsContainerBehind.classList.add('behind');
  tabElement.appendChild(extraItemsContainerBehind);

  tabElement.setAttribute('draggable', true);

  applyStatesToElement(tab);

  const window  = TabsStore.windows.get(tab.windowId);
  const nextTab = tab.$TST.unsafeNextTab;
  log(`creating tab element for ${tab.id} before ${nextTab && nextTab.id}, tab, nextTab = `, tab, nextTab);
  window.element.insertBefore(tabElement, nextTab && nextTab.$TST.element);
});


let mReservedUpdateActiveTab;

configs.$addObserver(async changedKey => {
  switch (changedKey) {
    case 'labelOverflowStyle':
      document.documentElement.setAttribute(Constants.kLABEL_OVERFLOW, configs.labelOverflowStyle);
      break;
  }
});


// Mechanism to override "index" of newly opened tabs by TST's detection logic

const mMovedNewTabResolvers = new Map();
const mPromsiedMovedNewTabs = new Map();
const mAlreadyMovedNewTabs = new Set();

export async function waitUntilNewTabIsMoved(tabId) {
  if (mAlreadyMovedNewTabs.has(tabId))
    return true;
  if (mPromsiedMovedNewTabs.has(tabId))
    return mPromsiedMovedNewTabs.get(tabId);
  const timer = setTimeout(() => {
    if (mMovedNewTabResolvers.has(tabId))
      mMovedNewTabResolvers.get(tabId)();
  }, Math.max(0, configs.autoGroupNewTabsTimeout));
  const promise = new Promise((resolve, _reject) => {
    mMovedNewTabResolvers.set(tabId, resolve);
  }).then(newIndex => {
    mMovedNewTabResolvers.delete(tabId);
    mPromsiedMovedNewTabs.delete(tabId);
    clearTimeout(timer);
    return newIndex;
  });
  mPromsiedMovedNewTabs.set(tabId, promise);
  return promise;
}

function maybeNewTabIsMoved(tabId) {
  if (mMovedNewTabResolvers.has(tabId)) {
    mMovedNewTabResolvers.get(tabId)();
  }
  else {
    mAlreadyMovedNewTabs.add(tabId);
    setTimeout(() => {
      mAlreadyMovedNewTabs.delete(tabId);
    }, Math.min(10 * 1000, configs.autoGroupNewTabsTimeout));
  }
}


const mPendingUpdates = new Map();

function setupPendingUpdate(update) {
  const pendingUpdate = mPendingUpdates.get(update.tabId) || { tabId: update.tabId };

  update.addedStates       = new Set(update.addedStates || []);
  update.removedStates     = new Set(update.removedStates || []);
  update.removedAttributes = new Set(update.removedAttributes || []);
  update.addedAttributes   = update.addedAttributes || {};
  update.updatedProperties = update.updatedProperties || {};

  pendingUpdate.updatedProperties = Object.assign({}, pendingUpdate.updatedProperties || {}, update.updatedProperties);

  if (update.removedAttributes.size > 0) {
    pendingUpdate.removedAttributes = new Set([...(pendingUpdate.removedAttributes || []), ...update.removedAttributes]);
    if (pendingUpdate.addedAttributes)
      for (const attribute of update.removedAttributes) {
        delete pendingUpdate.addedAttributes[attribute];
      }
  }

  if (Object.keys(update.addedAttributes).length > 0) {
    pendingUpdate.addedAttributes = Object.assign({}, pendingUpdate.addedAttributes || {}, update.addedAttributes);
    if (pendingUpdate.removedAttributes)
      for (const attribute of Object.keys(update.removedAttributes)) {
        pendingUpdate.removedAttributes.delete(attribute);
      }
  }

  if (update.removedStates.size > 0) {
    pendingUpdate.removedStates = new Set([...(pendingUpdate.removedStates || []), ...update.removedStates]);
    if (pendingUpdate.addedStates)
      for (const state of update.removedStates) {
        pendingUpdate.addedStates.delete(state);
      }
  }

  if (update.addedStates.size > 0) {
    pendingUpdate.addedStates = new Set([...(pendingUpdate.addedStates || []), ...update.addedStates]);
    if (pendingUpdate.removedStates)
      for (const state of update.addedStates) {
        pendingUpdate.removedStates.delete(state);
      }
  }

  pendingUpdate.soundStateChanged = pendingUpdate.soundStateChanged || update.soundStateChanged;

  mPendingUpdates.set(update.tabId, pendingUpdate);
}

function tryApplyUpdate(update) {
  const tab = Tab.get(update.tabId);
  if (!tab)
    return;

  const highlightedChanged = update.updatedProperties && 'highlighted' in update.updatedProperties;

  if (update.updatedProperties) {
    for (const key of Object.keys(update.updatedProperties)) {
      if (Tab.UNSYNCHRONIZABLE_PROPERTIES.has(key))
        continue;
      tab[key] = update.updatedProperties[key];
    }
  }

  if (update.addedAttributes) {
    for (const key of Object.keys(update.addedAttributes)) {
      tab.$TST.setAttribute(key, update.addedAttributes[key]);
    }
  }

  if (update.removedAttributes) {
    for (const key of update.removedAttributes) {
      tab.$TST.removeAttribute(key, );
    }
  }

  if (update.addedStates) {
    for (const state of update.addedStates) {
      tab.$TST.addState(state);
    }
  }

  if (update.removedStates) {
    for (const state of update.removedStates) {
      tab.$TST.removeState(state);
    }
  }

  if (update.soundStateChanged) {
    const parent = tab.$TST.parent;
    if (parent)
      parent.$TST.inheritSoundStateFromChildren();
  }

  tab.$TST.invalidateElement(TabInvalidationTarget.SoundButton | TabInvalidationTarget.Tooltip);

  if (highlightedChanged) {
    tab.$TST.invalidateElement(TabInvalidationTarget.CloseBox);
    for (const ancestor of tab.$TST.ancestors) {
      ancestor.$TST.updateElement(TabUpdateTarget.DescendantsHighlighted);
    }
    if (mReservedUpdateActiveTab)
      clearTimeout(mReservedUpdateActiveTab);
    mReservedUpdateActiveTab = setTimeout(() => {
      mReservedUpdateActiveTab = null;
      const activeTab = Tab.getActiveTab(tab.windowId);
      activeTab.$TST.invalidateElement(TabInvalidationTarget.SoundButton | TabInvalidationTarget.CloseBox);
    }, 50);
  }
}

async function activateRealActiveTab(windowId) {
  const tabs = await browser.tabs.query({ active: true, windowId });
  if (tabs.length <= 0)
    throw new Error(`FATAL ERROR: No active tab in the window ${windowId}`);
  const id = tabs[0].id;
  await Tab.waitUntilTracked(id, { element: true });
  const tab = Tab.get(id);
  if (!tab)
    throw new Error(`FATAL ERROR: Active tab ${id} in the window ${windowId} is not tracked`);
  TabsStore.activeTabInWindow.set(windowId, tab);
  TabsInternalOperation.setTabActive(tab);
}


BackgroundConnection.onMessage.addListener(async message => {
  switch (message.type) {
    case Constants.kCOMMAND_SYNC_TABS_ORDER:
      reserveToSyncTabsOrder();
      break;

    case Constants.kCOMMAND_BROADCAST_TAB_STATE: {
      if (!message.tabIds.length)
        break;
      await Tab.waitUntilTracked(message.tabIds, { element: true });
      const add    = message.add || [];
      const remove = message.remove || [];
      log('apply broadcasted tab state ', message.tabIds, {
        add:    add.join(','),
        remove: remove.join(',')
      });
      const modified = add.concat(remove);
      for (const id of message.tabIds) {
        const tab = Tab.get(id);
        if (!tab)
          continue;
        add.forEach(state => tab.$TST.addState(state));
        remove.forEach(state => tab.$TST.removeState(state));
        if (modified.includes(Constants.kTAB_STATE_AUDIBLE) ||
            modified.includes(Constants.kTAB_STATE_SOUND_PLAYING) ||
            modified.includes(Constants.kTAB_STATE_MUTED)) {
          tab.$TST.invalidateElement(TabInvalidationTarget.SoundButton);
        }
      }
    }; break;

    case Constants.kCOMMAND_NOTIFY_TAB_CREATING: {
      const nativeTab = message.tab;
      nativeTab.reindexedBy = `creating (${nativeTab.index})`;

      // The "index" property of the tab was already updated by the master process
      // with other newly opened tabs. However, such other tabs are not tracked on
      // this sidebar namespace yet. Thus we need to correct the index of the tab
      // to be inserted to already tracked tabs.
      // For example:
      //  - tabs in the background page: [a,b,X,Y,Z,c,d]
      //  - tabs in the sidebar page:    [a,b,c,d]
      //  - notified tab:                Z (as index=4) (X and Y will be notified later)
      // then the new tab Z must be treated as index=2 and the result must become
      // [a,b,Z,c,d] instead of [a,b,c,d,Z]. How should we calculate the index with
      // less amount?
      const window = TabsStore.windows.get(message.windowId);
      let index = 0;
      for (const id of message.order) {
        if (window.tabs.has(id)) {
          nativeTab.index = ++index;
          nativeTab.reindexedBy = `creating/fixed (${nativeTab.index})`;
        }
        if (id == message.tabId)
          break;
      }

      const tab = Tab.init(nativeTab, { inBackground: true });
      TabsUpdate.updateTab(tab, tab, { forceApply: true });

      tab.$TST.addState(Constants.kTAB_STATE_THROBBER_UNSYNCHRONIZED);
      TabsStore.addUnsynchronizedTab(tab);
      TabsStore.addLoadingTab(tab);
      if (configs.animation) {
        CollapseExpand.setCollapsed(tab, {
          collapsed: true,
          justNow:   true
        });
        tab.$TST.shouldExpandLater = true;
      }
      else {
        reserveToUpdateLoadingState();
      }
    }; break;

    case Constants.kCOMMAND_NOTIFY_TAB_CREATED: {
      await Tab.waitUntilTracked(message.tabId, { element: true });
      const tab = Tab.get(message.tabId);
      if (!tab)
        return;
      tab.$TST.addState(Constants.kTAB_STATE_ANIMATION_READY);
      tab.$TST.resolveOpened();
      if (message.maybeMoved)
        await waitUntilNewTabIsMoved(message.tabId);
      if (configs.animation) {
        await wait(0); // nextFrame() is too fast!
        if (tab.$TST.shouldExpandLater)
          CollapseExpand.setCollapsed(tab, {
            collapsed: false
          });
        reserveToUpdateLoadingState();
      }
    }; break;

    case Constants.kCOMMAND_NOTIFY_TAB_RESTORED: {
      await Tab.waitUntilTracked(message.tabId, { element: true });
      const tab = Tab.get(message.tabId);
      if (!tab)
        return;
      tab.$TST.addState(Constants.kTAB_STATE_RESTORED);
    }; break;

    case Constants.kCOMMAND_NOTIFY_TAB_ACTIVATED: {
      await Tab.waitUntilTracked(message.tabId, { element: true });
      const tab = Tab.get(message.tabId);
      if (tab) {
        TabsStore.activeTabInWindow.set(message.windowId, tab);
        TabsInternalOperation.setTabActive(tab);
      }
    }; break;

    case Constants.kCOMMAND_NOTIFY_TAB_UPDATED: {
      const hasPendingUpdate = mPendingUpdates.has(message.tabId);

      // Updates may be notified before the tab element is actually created,
      // so we should apply updates ASAP. We can update already tracked tab
      // while "creating" is notified and waiting for "created".
      // See also: https://github.com/piroor/treestyletab/issues/2275
      tryApplyUpdate(message);
      setupPendingUpdate(message);

      // Already pending update will be processed later, so we don't need
      // process this update.
      if (hasPendingUpdate)
        return;

      await Tab.waitUntilTracked(message.tabId, { element: true });
      const tab = Tab.get(message.tabId);
      if (!tab)
        return;

      const update = mPendingUpdates.get(message.tabId) || message;
      mPendingUpdates.delete(update.tabId);

      tryApplyUpdate(update);

      TabsStore.updateIndexesForTab(tab);
    }; break;

    case Constants.kCOMMAND_NOTIFY_TAB_MOVED: {
      maybeNewTabIsMoved(message.tabId);
      await Tab.waitUntilTracked([message.tabId, message.nextTabId], { element: true });
      const tab     = Tab.get(message.tabId);
      if (!tab ||
          tab.index == message.newIndex)
        return;
      const nextTab = Tab.get(message.nextTabId);
      if (mPromisedInitialized)
        await mPromisedInitialized;
      if (tab.$TST.parent)
        tab.$TST.parent.$TST.invalidateElement(TabInvalidationTarget.Tooltip);

      tab.$TST.addState(Constants.kTAB_STATE_MOVING);

      let shouldAnimate = false;
      if (configs.animation &&
          !tab.pinned &&
          !tab.$TST.opening &&
          !tab.$TST.collapsed) {
        shouldAnimate = true;
        CollapseExpand.setCollapsed(tab, {
          collapsed: true,
          justNow:   true
        });
        tab.$TST.shouldExpandLater = true;
      }

      tab.index = message.newIndex;
      tab.reindexedBy = `moved (${tab.index})`;
      const window = TabsStore.windows.get(message.windowId);
      window.trackTab(tab);
      tab.$TST.element.parentNode.insertBefore(tab.$TST.element, nextTab && nextTab.$TST.element);

      if (shouldAnimate && tab.$TST.shouldExpandLater) {
        CollapseExpand.setCollapsed(tab, {
          collapsed: false
        });
        await wait(configs.collapseDuration);
      }
      tab.$TST.removeState(Constants.kTAB_STATE_MOVING);
    }; break;

    case Constants.kCOMMAND_NOTIFY_TAB_INTERNALLY_MOVED: {
      maybeNewTabIsMoved(message.tabId);
      await Tab.waitUntilTracked([message.tabId, message.nextTabId], { element: true });
      const tab         = Tab.get(message.tabId);
      if (!tab ||
          tab.index == message.newIndex)
        return;
      tab.index = message.newIndex;
      tab.reindexedBy = `internally moved (${tab.index})`;
      Tab.track(tab);
      const tabElement  = tab.$TST.element;
      const nextTab     = Tab.get(message.nextTabId);
      const nextElement = nextTab && nextTab.$TST.element;
      if (tabElement.nextSibling != nextElement)
        tabElement.parentNode.insertBefore(tabElement, nextElement);
      if (!message.broadcasted) {
        // Tab element movement triggered by sidebar itself can break order of
        // tabs synchronized from the background, so for safetyl we trigger
        // synchronization.
        reserveToSyncTabsOrder();
      }
    }; break;

    case Constants.kCOMMAND_UPDATE_LOADING_STATE: {
      await Tab.waitUntilTracked(message.tabId, { element: true });
      const tab = Tab.get(message.tabId);
      if (tab) {
        if (message.status == 'loading') {
          tab.$TST.removeState(Constants.kTAB_STATE_BURSTING);
          TabsStore.addLoadingTab(tab);
          tab.$TST.addState(Constants.kTAB_STATE_THROBBER_UNSYNCHRONIZED);
          TabsStore.addUnsynchronizedTab(tab);
        }
        else {
          if (message.reallyChanged) {
            tab.$TST.addState(Constants.kTAB_STATE_BURSTING);
            if (tab.$TST.delayedBurstEnd)
              clearTimeout(tab.$TST.delayedBurstEnd);
            tab.$TST.delayedBurstEnd = setTimeout(() => {
              delete tab.$TST.delayedBurstEnd;
              tab.$TST.removeState(Constants.kTAB_STATE_BURSTING);
              if (!tab.active)
                tab.$TST.addState(Constants.kTAB_STATE_NOT_ACTIVATED_SINCE_LOAD);
            }, configs.burstDuration);
          }
          tab.$TST.removeState(Constants.kTAB_STATE_THROBBER_UNSYNCHRONIZED);
          TabsStore.removeUnsynchronizedTab(tab);
          TabsStore.removeLoadingTab(tab);
        }
      }
      reserveToUpdateLoadingState();
    }; break;

    case Constants.kCOMMAND_NOTIFY_TAB_REMOVING: {
      const tab = Tab.get(message.tabId);
      if (!tab)
        return;
      tab.$TST.parent = null;
      // remove from "highlighted tabs" cache immediately, to prevent misdetection for "multiple highlighted".
      TabsStore.removeHighlightedTab(tab);
      TabsStore.removeGroupTab(tab);
      TabsStore.addRemovingTab(tab);
      TabsStore.addRemovedTab(tab); // reserved
      reserveToUpdateLoadingState();
      if (tab.active) {
        // This should not, but sometimes happens on some edge cases for example:
        // https://github.com/piroor/treestyletab/issues/2385
        activateRealActiveTab(message.windowId);
      }
    }; break;

    case Constants.kCOMMAND_NOTIFY_TAB_REMOVED: {
      const tab = Tab.get(message.tabId);
      TabsStore.windows.get(message.windowId).detachTab(message.tabId);
      if (!tab)
        return;
      if (tab.active) {
        // This should not, but sometimes happens on some edge cases for example:
        // https://github.com/piroor/treestyletab/issues/2385
        activateRealActiveTab(message.windowId);
      }
      if (!tab.$TST.collapsed &&
          configs.animation) {
        const tabRect = tab.$TST.element.getBoundingClientRect();
        tab.$TST.element.style.marginLeft = `${tabRect.width}px`;
        CollapseExpand.setCollapsed(tab, {
          collapsed: true
        });
        await wait(configs.animation ? configs.collapseDuration : 0);
      }
      tab.$TST.destroy();
    }; break;

    case Constants.kCOMMAND_NOTIFY_TAB_LABEL_UPDATED: {
      await Tab.waitUntilTracked(message.tabId, { element: true });
      const tab = Tab.get(message.tabId);
      if (!tab)
        return;
      tab.$TST.label = tab.$TST.element.label = message.label;
    }; break;

    case Constants.kCOMMAND_NOTIFY_TAB_FAVICON_UPDATED: {
      await Tab.waitUntilTracked(message.tabId, { element: true });
      const tab = Tab.get(message.tabId);
      if (!tab)
        return;
      tab.favIconUrl = message.favIconUrl;
      tab.$TST.favIconUrl = message.favIconUrl;
    }; break;

    case Constants.kCOMMAND_NOTIFY_TAB_SOUND_STATE_UPDATED: {
      await Tab.waitUntilTracked(message.tabId, { element: true });
      const tab = Tab.get(message.tabId);
      if (!tab)
        return;
      if (message.hasSoundPlayingMember)
        tab.$TST.addState(Constants.kTAB_STATE_HAS_SOUND_PLAYING_MEMBER);
      else
        tab.$TST.removeState(Constants.kTAB_STATE_HAS_SOUND_PLAYING_MEMBER);
      if (message.hasMutedMember)
        tab.$TST.addState(Constants.kTAB_STATE_HAS_MUTED_MEMBER);
      else
        tab.$TST.removeState(Constants.kTAB_STATE_HAS_MUTED_MEMBER);
      tab.$TST.invalidateElement(TabInvalidationTarget.SoundButton);
    }; break;

    case Constants.kCOMMAND_NOTIFY_HIGHLIGHTED_TABS_CHANGED: {
      await Tab.waitUntilTracked(message.tabIds, { element: true });
      TabsUpdate.updateTabsHighlighted(message);
      const window = TabsStore.windows.get(message.windowId);
      if (!window || !window.element)
        return;
      window.classList.toggle(Constants.kTABBAR_STATE_MULTIPLE_HIGHLIGHTED, message.tabIds.length > 1);
    }; break;

    case Constants.kCOMMAND_NOTIFY_TAB_PINNED: {
      await Tab.waitUntilTracked(message.tabId, { element: true });
      const tab = Tab.get(message.tabId);
      if (!tab)
        return;
      tab.pinned = true;
      TabsStore.removeUnpinnedTab(tab);
      TabsStore.addPinnedTab(tab);
    }; break;

    case Constants.kCOMMAND_NOTIFY_TAB_UNPINNED: {
      await Tab.waitUntilTracked(message.tabId, { element: true });
      const tab = Tab.get(message.tabId);
      if (!tab)
        return;
      tab.pinned = false;
      TabsStore.removePinnedTab(tab);
      TabsStore.addUnpinnedTab(tab);
    }; break;

    case Constants.kCOMMAND_NOTIFY_TAB_HIDDEN: {
      await Tab.waitUntilTracked(message.tabId, { element: true });
      const tab = Tab.get(message.tabId);
      if (!tab)
        return;
      tab.hidden = true;
      TabsStore.removeVisibleTab(tab);
      TabsStore.removeControllableTab(tab);
    }; break;

    case Constants.kCOMMAND_NOTIFY_TAB_SHOWN: {
      await Tab.waitUntilTracked(message.tabId, { element: true });
      const tab = Tab.get(message.tabId);
      if (!tab)
        return;
      tab.hidden = false;
      if (!tab.$TST.collapsed)
        TabsStore.addVisibleTab(tab);
      TabsStore.addControllableTab(tab);
    }; break;

    case Constants.kCOMMAND_NOTIFY_SUBTREE_COLLAPSED_STATE_CHANGED: {
      await Tab.waitUntilTracked(message.tabId, { element: true });
      const tab = Tab.get(message.tabId);
      if (!tab)
        return;
      tab.$TST.invalidateElement(TabInvalidationTarget.CloseBox);
    }; break;

    case Constants.kCOMMAND_NOTIFY_TAB_COLLAPSED_STATE_CHANGED: {
      if (message.collapsed)
        return;
      await Tab.waitUntilTracked(message.tabId, { element: true });
      const tab = Tab.get(message.tabId);
      if (!tab)
        return;
      TabsStore.addVisibleTab(tab);
      TabsStore.addExpandedTab(tab);
      reserveToUpdateLoadingState();
      tab.$TST.invalidateElement(TabInvalidationTarget.Twisty | TabInvalidationTarget.CloseBox | TabInvalidationTarget.Tooltip);
      tab.$TST.element.updateOverflow();
    }; break;

    case Constants.kCOMMAND_NOTIFY_TAB_ATTACHED_TO_WINDOW: {
      await Tab.waitUntilTracked(message.tabId, { element: true });
      const tab = Tab.get(message.tabId);
      if (!tab)
        return;
      if (tab.active)
        TabsInternalOperation.setTabActive(tab); // to clear "active" state of other tabs
    }; break;

    case Constants.kCOMMAND_NOTIFY_TAB_DETACHED_FROM_WINDOW: {
      // don't wait until tracked here, because detaching tab will become untracked!
      const tab = Tab.get(message.tabId);
      if (!tab)
        return;
      tab.$TST.invalidateElement(TabInvalidationTarget.Tooltip);
      tab.$TST.parent = null;
      TabsStore.addRemovedTab(tab);
      const window = TabsStore.windows.get(message.windowId);
      window.untrackTab(message.tabId);
      if (tab.$TST.element && tab.$TST.element.parentNode)
        tab.$TST.element.parentNode.removeChild(tab.$TST.element);
      // Allow to move tabs to this window again, after a timeout.
      // https://github.com/piroor/treestyletab/issues/2316
      wait(500).then(() => TabsStore.removeRemovedTab(tab));
    }; break;

    case Constants.kCOMMAND_NOTIFY_GROUP_TAB_DETECTED: {
      await Tab.waitUntilTracked(message.tabId, { element: true });
      const tab = Tab.get(message.tabId);
      if (!tab)
        return;
      // When a group tab is restored but pending, TST cannot update title of the tab itself.
      // For failsafe now we update the title based on its URL.
      const uri = tab.url;
      const parameters = uri.replace(/^[^\?]+/, '');
      let title = parameters.match(/[&?]title=([^&;]*)/);
      if (!title)
        title = parameters.match(/^\?([^&;]*)/);
      title = title && decodeURIComponent(title[1]) ||
               browser.i18n.getMessage('groupTab_label_default');
      tab.title = title;
      wait(0).then(() => {
        TabsUpdate.updateTab(tab, { title });
      });
    }; break;

    case Constants.kCOMMAND_NOTIFY_CHILDREN_CHANGED: {
      if (mPromisedInitialized)
        return;
      // We need to wait not only for added children but removed children also,
      // to construct same number of promises for "attached but detached immediately"
      // cases.
      const relatedTabIds = [message.tabId].concat(message.addedChildIds, message.removedChildIds);
      await Tab.waitUntilTracked(relatedTabIds, { element: true });
      const tab = Tab.get(message.tabId);
      if (!tab)
        return;

      if (message.addedChildIds.length > 0) {
        // set initial level for newly opened child, to avoid annoying jumping of new tab
        const childLevel = parseInt(tab.$TST.getAttribute(Constants.kLEVEL) || 0) + 1;
        for (const childId of message.addedChildIds) {
          const child = Tab.get(childId);
          if (!child || child.$TST.hasChild)
            continue;
          const currentLevel = child.$TST.getAttribute(Constants.kLEVEL) || 0;
          if (currentLevel == 0)
            child.$TST.setAttribute(Constants.kLEVEL, childLevel);
        }
      }

      tab.$TST.children = message.childIds;

      tab.$TST.invalidateElement(TabInvalidationTarget.Twisty | TabInvalidationTarget.CloseBox | TabInvalidationTarget.Tooltip);
      if (message.newlyAttached || message.detached) {
        const ancestors = [tab].concat(tab.$TST.ancestors);
        for (const ancestor of ancestors) {
          ancestor.$TST.updateElement(TabUpdateTarget.Counter | TabUpdateTarget.DescendantsHighlighted);
        }
      }
    }; break;
  }
});
