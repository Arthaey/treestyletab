/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import {
  log as internalLogger,
  dumpTab,
  wait,
  mapAndFilterUniq,
  countMatched,
  configs
} from '/common/common.js';

import * as Constants from '/common/constants.js';
import * as ApiTabs from '/common/api-tabs.js';
import * as TabsStore from '/common/tabs-store.js';
import * as TabsInternalOperation from '/common/tabs-internal-operation.js';
import * as TreeBehavior from '/common/tree-behavior.js';
import * as SidebarConnection from '/common/sidebar-connection.js';

import Tab from '/common/Tab.js';

import * as Background from './background.js';
import * as TabsGroup from './tabs-group.js';
import * as TabsOpen from './tabs-open.js';
import * as Tree from './tree.js';

function log(...args) {
  internalLogger('background/handle-removed-tabs', ...args);
}


Tab.onRemoving.addListener(async (tab, removeInfo = {}) => {
  log('Tabs.onRemoving ', dumpTab(tab), removeInfo);
  if (removeInfo.isWindowClosing)
    return;

  let closeParentBehavior;
  if (tab.$TST.mayBeOriginalOfReplacedWithContainer)
    closeParentBehavior = Constants.kCLOSE_PARENT_BEHAVIOR_PROMOTE_FIRST_CHILD;
  else
    closeParentBehavior = TreeBehavior.getCloseParentBehaviorForTabWithSidebarOpenState(tab, removeInfo);

  if (!SidebarConnection.isOpen(tab.windowId) &&
      closeParentBehavior != Constants.kCLOSE_PARENT_BEHAVIOR_CLOSE_ALL_CHILDREN &&
      tab.$TST.subtreeCollapsed)
    Tree.collapseExpandSubtree(tab, {
      collapsed: false,
      justNow:   true,
      broadcast: false // because the tab is going to be closed, broadcasted Tree.collapseExpandSubtree can be ignored.
    });

  if (!(await tryGrantCloseTab(tab, closeParentBehavior)))
    return;
  log('Tabs.onRemoving: granted to close ', dumpTab(tab));

  if (closeParentBehavior == Constants.kCLOSE_PARENT_BEHAVIOR_CLOSE_ALL_CHILDREN)
    await closeChildTabs(tab);

  if (closeParentBehavior == Constants.kCLOSE_PARENT_BEHAVIOR_REPLACE_WITH_GROUP_TAB &&
      tab.$TST.childIds.length > 1 &&
      countMatched(tab.$TST.children,
                   tab => !tab.$TST.states.has(Constants.kTAB_STATE_TO_BE_REMOVED)) > 1) {
    log('trying to replace the closing tab with a new group tab');
    const firstChild = tab.$TST.firstChild;
    const uri = TabsGroup.makeGroupTabURI({
      title:     browser.i18n.getMessage('groupTab_label', firstChild.title),
      temporaryAggressive: true
    });
    const window = TabsStore.windows.get(tab.windowId);
    window.toBeOpenedTabsWithPositions++;
    const groupTab = await TabsOpen.openURIInTab(uri, {
      windowId:     tab.windowId,
      insertBefore: tab, // not firstChild, because the "tab" is disappeared from tree.
      inBackground: true
    });
    log('group tab: ', dumpTab(groupTab));
    if (!groupTab) // the window is closed!
      return;
    await Tree.attachTabTo(groupTab, tab, {
      insertBefore: firstChild,
      broadcast:    true
    });
    closeParentBehavior = Constants.kCLOSE_PARENT_BEHAVIOR_PROMOTE_FIRST_CHILD;
    // This can be triggered on closing of multiple tabs,
    // so we should cleanup it on such cases for safety.
    // https://github.com/piroor/treestyletab/issues/2317
    wait(1000).then(() => TabsGroup.reserveToCleanupNeedlessGroupTab(groupTab));
  }

  Tree.detachAllChildren(tab, {
    behavior:  closeParentBehavior,
    broadcast: true
  });
  //reserveCloseRelatedTabs(toBeClosedTabs);
  // We should skip needless operation if it is a bulk tab close
  const window = TabsStore.windows.get(tab.windowId);
  if (!window.internalClosingTabs.has(tab.$TST.parentId))
    Tree.detachTab(tab, {
      dontUpdateIndent: true,
      broadcast:        true
    });
});

async function tryGrantCloseTab(tab, closeParentBehavior) {
  log('tryGrantClose: ', { alreadyGranted: configs.grantedRemovingTabIds, closing: dumpTab(tab) });
  const alreadyGranted = configs.grantedRemovingTabIds.includes(tab.id);
  configs.grantedRemovingTabIds = configs.grantedRemovingTabIds.filter(id => id != tab.id);
  if (alreadyGranted)
    return true;

  const self = tryGrantCloseTab;

  self.closingTabIds.push(tab.id);
  if (closeParentBehavior == Constants.kCLOSE_PARENT_BEHAVIOR_CLOSE_ALL_CHILDREN) {
    self.closingDescendantTabIds = self.closingDescendantTabIds
      .concat(TreeBehavior.getClosingTabsFromParent(tab).map(tab => tab.id));
    self.closingDescendantTabIds = Array.from(new Set(self.closingDescendantTabIds));
  }

  if (self.promisedGrantedToCloseTabs)
    return self.promisedGrantedToCloseTabs;

  self.closingTabWasActive = self.closingTabWasActive || tab.active;

  let shouldRestoreCount;
  self.promisedGrantedToCloseTabs = wait(10).then(async () => {
    const closingTabIds = new Set(self.closingTabIds);
    let allClosingTabs = new Set();
    allClosingTabs.add(tab);
    self.closingTabIds = Array.from(closingTabIds);
    self.closingDescendantTabIds = mapAndFilterUniq(self.closingDescendantTabIds, id => {
      if (closingTabIds.has(id))
        return undefined;
      allClosingTabs.add(Tab.get(id));
      return id;
    });
    allClosingTabs = Array.from(allClosingTabs);
    shouldRestoreCount = self.closingTabIds.length;
    const restorableClosingTabsCount = countMatched(allClosingTabs,
                                                    tab => tab.url != 'about:blank' &&
                                                           tab.url != configs.guessNewOrphanTabAsOpenedByNewTabCommandUrl);
    if (restorableClosingTabsCount > 0) {
      log('tryGrantClose: show confirmation for ', allClosingTabs);
      return Background.confirmToCloseTabs(allClosingTabs.map(tab => tab.$TST.sanitized), {
        windowId: tab.windowId
      });
    }
    return true;
  })
    .then(async (granted) => {
      // remove the closed tab itself because it is already closed!
      configs.grantedRemovingTabIds = configs.grantedRemovingTabIds.filter(id => id != tab.id);
      if (granted)
        return true;
      log(`tryGrantClose: not granted, restore ${shouldRestoreCount} tabs`);
      // this is required to wait until the closing tab is stored to the "recently closed" list
      wait(0).then(async () => {
        const sessions = await browser.sessions.getRecentlyClosed({ maxResults: shouldRestoreCount * 2 }).catch(ApiTabs.  createErrorHandler());
        const toBeRestoredTabs = [];
        for (const session of sessions) {
          if (!session.tab)
            continue;
          toBeRestoredTabs.push(session.tab);
          if (toBeRestoredTabs.length == shouldRestoreCount)
            break;
        }
        const promisedRestoredTabSets = [];
        for (const tab of toBeRestoredTabs.reverse()) {
          log('tryGrantClose: Tabrestoring session = ', tab);
          promisedRestoredTabSets.push(Tab.doAndGetNewTabs(async () => {
            browser.sessions.restore(tab.sessionId).catch(ApiTabs.createErrorSuppressor());
            await Tab.waitUntilTrackedAll();
          }));
        }
        const restoredTabs = (await Promise.all(promisedRestoredTabSets)).flat();
        await Promise.all(restoredTabs.map(tab => tab && Tab.get(tab.id).$TST.opened));
        log('tryGrantClose: restored ', restoredTabs);
      });
      return false;
    });

  const granted = await self.promisedGrantedToCloseTabs;
  self.closingTabIds              = [];
  self.closingDescendantTabIds    = [];
  self.closingTabWasActive        = false;
  self.promisedGrantedToCloseTabs = null;
  return granted;
}
tryGrantCloseTab.closingTabIds              = [];
tryGrantCloseTab.closingDescendantTabIds    = [];
tryGrantCloseTab.closingTabWasActive        = false;
tryGrantCloseTab.promisedGrantedToCloseTabs = null;

async function closeChildTabs(parent) {
  const tabs = parent.$TST.descendants;
  //if (!fireTabSubtreeClosingEvent(parent, tabs))
  //  return;

  //markAsClosedSet([parent].concat(tabs));
  // close bottom to top!
  await TabsInternalOperation.removeTabs(tabs.reverse());
  //fireTabSubtreeClosedEvent(parent, tabs);
}

Tab.onRemoved.addListener((tab, info) => {
  log('Tabs.onRemoved: removed ', dumpTab(tab));
  configs.grantedRemovingTabIds = configs.grantedRemovingTabIds.filter(id => id != tab.id);

  if (info.isWindowClosing)
    return;

  // The removing tab may be attached to another tab or
  // other tabs may be attached to the removing tab.
  // We need to detach such relations always on this timing.
  if (info.oldChildren.length > 0) {
    Tree.detachAllChildren(tab, {
      children:  info.oldChildren,
      parent:    info.oldParent,
      behavior:  Constants.kCLOSE_PARENT_BEHAVIOR_PROMOTE_FIRST_CHILD,
      broadcast: true
    });
  }
  if (info.oldParent) {
    Tree.detachTab(tab, {
      parent:    info.oldParent,
      broadcast: true
    });
  }
});

browser.windows.onRemoved.addListener(windowId  => {
  const window = TabsStore.windows.get(windowId);
  if (!window)
    return;
  configs.grantedRemovingTabIds = configs.grantedRemovingTabIds.filter(id => !window.tabs.has(id));
});


Tab.onDetached.addListener((tab, info = {}) => {
  log('Tabs.onDetached ', dumpTab(tab));
  let closeParentBehavior = TreeBehavior.getCloseParentBehaviorForTabWithSidebarOpenState(tab, info);
  if (closeParentBehavior == Constants.kCLOSE_PARENT_BEHAVIOR_CLOSE_ALL_CHILDREN)
    closeParentBehavior = Constants.kCLOSE_PARENT_BEHAVIOR_PROMOTE_FIRST_CHILD;

  Tree.detachAllChildren(tab, {
    behavior:  closeParentBehavior,
    broadcast: true
  });
  //reserveCloseRelatedTabs(toBeClosedTabs);
  Tree.detachTab(tab, {
    dontUpdateIndent: true,
    broadcast:        true
  });
  //restoreTabAttributes(tab, backupAttributes);
});
