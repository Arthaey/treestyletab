/* ***** BEGIN LICENSE BLOCK ***** 
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is the Tree Style Tab.
 *
 * The Initial Developer of the Original Code is YUKI "Piro" Hiroshi.
 * Portions created by the Initial Developer are Copyright (C) 2011-2018
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s): YUKI "Piro" Hiroshi <piro.outsider.reflex@gmail.com>
 *                 wanabe <https://github.com/wanabe>
 *                 Tetsuharu OHZEKI <https://github.com/saneyuki>
 *                 Xidorn Quan <https://github.com/upsuper> (Firefox 40+ support)
 *                 lv7777 (https://github.com/lv7777)
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ******/
'use strict';

import {
  log as internalLogger,
  wait,
  configs
} from './common.js';

import * as Constants from './constants.js';
import * as ApiTabs from './api-tabs.js';
import * as Tabs from './tabs.js';
import { SequenceMatcher } from './diff.js';

function log(...args) {
  internalLogger('common/tabs-move', ...args);
}
function logApiTabs(...args) {
  internalLogger('common/api-tabs', ...args);
}


// ========================================================
// primitive methods for internal use

export async function moveTabsBefore(tabs, referenceTab, options = {}) {
  log('moveTabsBefore: ', tabs.map(tab => tab.id), referenceTab && referenceTab.id, options);
  if (!tabs.length ||
      !Tabs.ensureLivingTab(referenceTab))
    return [];

  if (Tabs.isAllTabsPlacedBefore(tabs, referenceTab)) {
    log('moveTabsBefore:no need to move');
    return [];
  }
  return moveTabsInternallyBefore(tabs, referenceTab, options);
}
export async function moveTabBefore(tab, referenceTab, options = {}) {
  return moveTabsBefore([tab], referenceTab, options).then(moved => moved.length > 0);
}

async function moveTabsInternallyBefore(tabs, referenceTab, options = {}) {
  if (!tabs.length ||
      !Tabs.ensureLivingTab(referenceTab))
    return [];

  const window = Tabs.trackedWindows.get(tabs[0].windowId);

  log('moveTabsInternallyBefore: ', tabs.map(tab => tab.id), referenceTab.id, options);
  if (options.inRemote || options.broadcast) {
    const message = {
      type:        Constants.kCOMMAND_MOVE_TABS_BEFORE,
      windowId:    tabs[0].windowId,
      tabIds:      tabs.map(tab => tab.id),
      nextTabId:   referenceTab.id,
      broadcasted: !!options.broadcast
    };
    if (options.inRemote) {
      const tabIds = await browser.runtime.sendMessage(message);
      return tabIds.map(id => Tabs.trackedTabs.get(id));
    }
    else {
      browser.runtime.sendMessage(message);
    }
  }

  try {
    /*
      Tab elements are moved by tabs.onMoved automatically, but
      the operation is asynchronous. To help synchronous operations
      following to this operation, we need to move tabs immediately.
    */
    let movedTabsCount = 0;
    for (const tab of tabs) {
      const oldPreviousTab = Tabs.getPreviousTab(tab, { living: false });
      const oldNextTab     = Tabs.getNextTab(tab, { living: false });
      if (oldNextTab && oldNextTab.id == referenceTab.id) // no move case
        continue;
      window.internalMovingTabs.add(tab.id);
      window.alreadyMovedTabs.add(tab.id);
      window.element.insertBefore(tab.$TST.element, referenceTab.$TST.element);
      if (referenceTab.index > tab.index)
        tab.index = referenceTab.index - 1;
      else
        tab.index = referenceTab.index;
      Tabs.track(tab);
      movedTabsCount++;
      Tabs.onTabElementMoved.dispatch(tab, {
        oldPreviousTab,
        oldNextTab,
        broadcasted: !!options.broadcasted
      });
    }
    syncOrderOfChildTabs(tabs.map(Tabs.getParentTab));
    if (movedTabsCount == 0) {
      log(' => actually nothing moved');
    }
    else {
      log('Tab nodes rearranged by moveTabsInternallyBefore:\n'+(!configs.debug ? '' :
        Array.from(window.element.childNodes)
          .map(tab => ' - '+tab.apiTab.index+': '+tab.id+(tabs.includes(tab.apiTab) ? '[MOVED]' : ''))
          .join('\n')));
    }
    if (!options.broadcasted) {
      if (options.delayedMove) // Wait until opening animation is finished.
        await wait(configs.newTabAnimationDuration);
      syncToNativeTabs(tabs);
    }
  }
  catch(e) {
    ApiTabs.handleMissingTabError(e);
    log('moveTabsInternallyBefore failed: ', String(e));
  }
  return tabs;
}
export async function moveTabInternallyBefore(tab, referenceTab, options = {}) {
  return moveTabsInternallyBefore([tab], referenceTab, options);
}

function syncOrderOfChildTabs(parentTabs) {
  if (!Array.isArray(parentTabs))
    parentTabs = [parentTabs];

  let updatedParentTabs = new Map();
  for (const parent of parentTabs) {
    if (!parent || updatedParentTabs.has(parent))
      continue;
    updatedParentTabs.set(parent, true);
    if (parent.$TST.children.length < 2)
      continue;
    parent.$TST.children = parent.$TST.children.sort((a, b) => a.index - b.index);
    const childIds = parent.$TST.children.map(child => child.$TST.element.id);
    Tabs.setAttribute(parent, Constants.kCHILDREN, `|${childIds.join('|')}|`);
    log('updateChildTabsInfo: ', childIds);
  }
  updatedParentTabs = undefined;
}

export async function moveTabsAfter(tabs, referenceTab, options = {}) {
  log('moveTabsAfter: ', tabs.map(tab => tab.id), referenceTab && referenceTab.id, options);
  if (!tabs.length ||
      !Tabs.ensureLivingTab(referenceTab))
    return [];

  if (Tabs.isAllTabsPlacedAfter(tabs, referenceTab)) {
    log('moveTabsAfter:no need to move');
    return [];
  }
  return moveTabsInternallyAfter(tabs, referenceTab, options);
}
export async function moveTabAfter(tab, referenceTab, options = {}) {
  return moveTabsAfter([tab], referenceTab, options).then(moved => moved.length > 0);
}

async function moveTabsInternallyAfter(tabs, referenceTab, options = {}) {
  if (!tabs.length ||
      !Tabs.ensureLivingTab(referenceTab))
    return [];

  const window = Tabs.trackedWindows.get(tabs[0].windowId);

  log('moveTabsInternallyAfter: ', tabs.map(tab => tab.id), referenceTab.id, options);
  if (options.inRemote || options.broadcast) {
    const message = {
      type:          Constants.kCOMMAND_MOVE_TABS_AFTER,
      windowId:      tabs[0].windowId,
      tabIds:        tabs.map(tab => tab.id),
      previousTabId: referenceTab.id,
      broadcasted:   !!options.broadcast
    };
    if (options.inRemote) {
      const tabIds = await browser.runtime.sendMessage(message);
      return tabIds.map(id => Tabs.trackedTabs.get(id));
    }
    else {
      browser.runtime.sendMessage(message);
    }
  }

  try {
    /*
      Tab elements are moved by tabs.onMoved automatically, but
      the operation is asynchronous. To help synchronous operations
      following to this operation, we need to move tabs immediately.
    */
    let nextTab = Tabs.getNextTab(referenceTab, { living: false });
    if (nextTab && tabs.find(tab => tab.id == nextTab.id))
      nextTab = null;
    let movedTabsCount = 0;
    for (const tab of tabs) {
      const oldPreviousTab = Tabs.getPreviousTab(tab, { living: false });
      const oldNextTab     = Tabs.getNextTab(tab, { living: false });
      if ((!oldNextTab && !nextTab) ||
          (oldNextTab && nextTab && oldNextTab.id == nextTab.id)) // no move case
        continue;
      window.internalMovingTabs.add(tab.id);
      window.alreadyMovedTabs.add(tab.id);
      window.element.insertBefore(tab.$TST.element, nextTab && nextTab.$TST.element);
      if (nextTab) {
        if (nextTab.index > tab.index)
          tab.index = nextTab.index - 1;
        else
          tab.index = nextTab.index;
      }
      else {
        tab.index = window.tabs.size - 1
      }
      Tabs.track(tab);
      movedTabsCount++;
      Tabs.onTabElementMoved.dispatch(tab, {
        oldPreviousTab,
        oldNextTab,
        broadcasted: !!options.broadcasted
      });
    }
    syncOrderOfChildTabs(tabs.map(Tabs.getParentTab));
    if (movedTabsCount == 0) {
      log(' => actually nothing moved');
    }
    else {
      log('Tab nodes rearranged by moveTabsInternallyAfter:\n'+(!configs.debug ? '' :
        Array.from(window.element.childNodes)
          .map(tab => ' - '+tab.apiTab.index+': '+tab.id+(tabs.includes(tab.apiTab) ? '[MOVED]' : ''))
          .join('\n')));
    }
    if (!options.broadcasted) {
      if (options.delayedMove) // Wait until opening animation is finished.
        await wait(configs.newTabAnimationDuration);
      syncToNativeTabs(tabs);
    }
  }
  catch(e) {
    ApiTabs.handleMissingTabError(e);
    log('moveTabsInternallyAfter failed: ', String(e));
  }
  return tabs;
}
export async function moveTabInternallyAfter(tab, referenceTab, options = {}) {
  return moveTabsInternallyAfter([tab], referenceTab, options);
}


// ========================================================
// Synchronize order of tab elements to browser's tabs

const mMovedTabs        = new Map();
const mPreviousSync     = new Map();
const mDelayedSync      = new Map();
const mDelayedSyncTimer = new Map();

export async function waitUntilSynchronized(windowId) {
  return mPreviousSync.get(windowId) || mDelayedSync.get(windowId);
}

function syncToNativeTabs(tabs) {
  const windowId = tabs[0].windowId;
  //log(`syncToNativeTabs(${windowId})`);
  const movedTabs = mMovedTabs.get(windowId) || [];
  mMovedTabs.set(windowId, movedTabs.concat(tabs));
  if (mDelayedSyncTimer.has(windowId))
    clearTimeout(mDelayedSyncTimer.get(windowId));
  const delayedSync = new Promise((resolve, _reject) => {
    mDelayedSyncTimer.set(windowId, setTimeout(() => {
      mDelayedSync.delete(windowId);
      let previousSync = mPreviousSync.get(windowId);
      if (previousSync)
        previousSync = previousSync.then(() => syncToNativeTabsInternal(windowId));
      else
        previousSync = syncToNativeTabsInternal(windowId);
      previousSync = previousSync.then(resolve);
      mPreviousSync.set(windowId, previousSync);
    }, 250));
  }).then(() => {
    mPreviousSync.delete(windowId);
  });
  mDelayedSync.set(windowId, delayedSync);
  return delayedSync;
}
async function syncToNativeTabsInternal(windowId) {
  mDelayedSyncTimer.delete(windowId);

  const oldMovedTabs = mMovedTabs.get(windowId) || [];
  mMovedTabs.delete(windowId);

  if (Tabs.hasCreatingTab(windowId))
    await Tabs.waitUntilAllTabsAreCreated(windowId);
  if (Tabs.hasMovingTab(windowId))
    await Tabs.waitUntilAllTabsAreMoved(windowId);

  const window = Tabs.trackedWindows.get(windowId);

  for (const tab of oldMovedTabs) {
    window.internalMovingTabs.delete(tab.id);
    window.alreadyMovedTabs.delete(tab.id);
  }

  // Tabs may be removed while waiting.
  const internalOrder   = Tabs.trackedWindows.get(windowId).order;
  const elementsOrder   = Array.from(window.element.childNodes, tabElement => tabElement.apiTab.id);
  const nativeTabsOrder = (await browser.tabs.query({ windowId })).map(tab => tab.id);
  log(`syncToNativeTabs(${windowId}): rearrange `, { internalOrder:internalOrder.join(','), elementsOrder:elementsOrder.join(','), nativeTabsOrder:nativeTabsOrder.join(',') });

  {
    log(`syncToNativeTabs(${windowId}): step0, internalOrder => elementsOrder`);
    const moveOperations = (new SequenceMatcher(elementsOrder, internalOrder)).operations();
    for (const operation of moveOperations) {
      const [tag, fromStart, fromEnd, toStart, toEnd] = operation;
      log(`syncToNativeTabs(${windowId}): step0, operation `, { tag, fromStart, fromEnd, toStart, toEnd });
      switch (tag) {
        case 'equal':
        case 'delete':
          break;

        case 'insert':
        case 'replace':
          const moveTabIds = internalOrder.slice(toStart, toEnd);
          const referenceTab = fromStart < elementsOrder.length ? Tabs.trackedTabs.get(elementsOrder[fromStart]) : null;
          for (const id of moveTabIds) {
            const tab = Tabs.trackedTabs.get(id);
            if (tab)
              tab.$TST.element.parentNode.insertBefore(tab.$TST.element, referenceTab && referenceTab.$TST.element);
          }
          break;
      }
    }
    log(`syncToNativeTabs(${windowId}): step0, rearrange completed. `, Array.from(window.element.childNodes, tab => tab.apiTab.id));
  }

  log(`syncToNativeTabs(${windowId}): step1, internalOrder => nativeTabsOrder`);
  let tabIdsForUpdatedIndices = Array.from(nativeTabsOrder);

  const moveOperations = (new SequenceMatcher(nativeTabsOrder, internalOrder)).operations();
  const movedTabs = new Set();
  for (const operation of moveOperations) {
    const [tag, fromStart, fromEnd, toStart, toEnd] = operation;
    log(`syncToNativeTabs(${windowId}): operation `, { tag, fromStart, fromEnd, toStart, toEnd });
    switch (tag) {
      case 'equal':
      case 'delete':
        break;

      case 'insert':
      case 'replace':
        let moveTabIds = internalOrder.slice(toStart, toEnd);
        const referenceId = nativeTabsOrder[fromStart] || null;
        let toIndex = -1;
        let fromIndices = moveTabIds.map(id => tabIdsForUpdatedIndices.indexOf(id));
        if (referenceId) {
          toIndex = tabIdsForUpdatedIndices.indexOf(referenceId);
        }
        if (toIndex < 0)
          toIndex = internalOrder.length;
        // ignore already removed tabs!
        moveTabIds = moveTabIds.filter((id, index) => fromIndices[index] > -1);
        if (moveTabIds.length == 0)
          continue;
        fromIndices = fromIndices.filter(index => index > -1);
        const fromIndex = fromIndices[0];
        if (fromIndex < toIndex)
          toIndex--;
        log(`syncToNativeTabs(${windowId}): step1, move ${moveTabIds.join(',')} before ${referenceId} / from = ${fromIndex}, to = ${toIndex}`);
        for (const movedId of moveTabIds) {
          window.internalMovingTabs.add(movedId);
          window.alreadyMovedTabs.add(movedId);
          movedTabs.add(movedId);
        }
        logApiTabs(`tabs-move:syncToNativeTabs(${windowId}): step1, browser.tabs.move() `, moveTabIds, {
          windowId,
          index: toIndex
        });
        browser.tabs.move(moveTabIds, {
          windowId,
          index: toIndex
        }).catch(e => {
          log(`syncToNativeTabs(${windowId}): step1, failed to move: `, String(e), e.stack);
        });
        tabIdsForUpdatedIndices = tabIdsForUpdatedIndices.filter(id => !moveTabIds.includes(id));
        tabIdsForUpdatedIndices.splice(toIndex, 0, ...moveTabIds);
        break;
    }
  }
  log(`syncToNativeTabs(${windowId}): step1, rearrange completed.`);

  if (movedTabs.size > 0) {
    log(`Tabs rearranged by syncToNativeTabs(${windowId}):\n`+(!configs.debug ? '' :
      Array.from(window.element.childNodes, tab => ' - '+tab.apiTab.index+': '+tab.id+(movedTabs.has(tab.apiTab.id) ? '[MOVED]' : '')+' '+tab.apiTab.title)
        .join('\n')));

    // tabs.onMoved produced by this operation can break the order of tabs
    // in the sidebar, so we need to synchronize complete order of tabs after
    // all.
    browser.runtime.sendMessage({
      type: Constants.kCOMMAND_SYNC_TABS_ORDER,
      windowId
    });

    // Multiple times asynchronous tab move is unstable, so we retry again
    // for safety until all tabs are completely synchronized.
    syncToNativeTabs([{ windowId }]);
  }
}
