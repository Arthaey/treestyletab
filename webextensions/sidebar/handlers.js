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
 * Portions created by the Initial Developer are Copyright (C) 2011-2017
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

function onResize(aEvent) {
  reserveToCheckTabbarOverflow();
}

function isAccelAction(aEvent) {
  return aEvent.button == 1 || (aEvent.button == 0 && isAccelKeyPressed(aEvent));
}

function isAccelKeyPressed(aEvent) {
  return gIsMac ?
    (aEvent.metaKey || ('keyCode' in aEvent && aEvent.keyCode == aEvent.DOM_VK_META)) :
    (aEvent.ctrlKey || ('keyCode' in aEvent && aEvent.keyCode == aEvent.DOM_VK_CONTROL)) ;
}

function isCopyAction(aEvent) {
  return isAccelKeyPressed(aEvent) ||
      (aEvent.dataTransfer && aEvent.dataTransfer.dropEffect == 'copy');
}

function isEventFiredOnTwisty(aEvent) {
  var tab = getTabFromEvent(aEvent);
  if (!tab || !hasChildTabs(tab))
    return false;

  var twisty = evaluateXPath(
    `ancestor-or-self::*[${hasClass(kTWISTY)}]`,
    aEvent.originalTarget || aEvent.target,
    XPathResult.BOOLEAN_TYPE
  ).booleanValue;
  if (twisty)
    return true;

  if (!configs.shouldExpandTwistyArea)
    return false;

  var favicon = evaluateXPath(
    `ancestor-or-self::*[${hasClass(kFAVICON)}]`,
    aEvent.originalTarget || aEvent.target,
    XPathResult.BOOLEAN_TYPE
  ).booleanValue;
  if (favicon)
    return true;

  return false;
}

function isEventFiredOnClosebox(aEvent) {
  return evaluateXPath(
      `ancestor-or-self::*[${hasClass(kCLOSEBOX)}]`,
      aEvent.originalTarget || aEvent.target,
      XPathResult.BOOLEAN_TYPE
    ).booleanValue;
}

function isEventFiredOnNewTabButton(aEvent) {
  return evaluateXPath(
      `ancestor-or-self::*[${hasClass(kNEWTAB_BUTTON)}]`,
      aEvent.originalTarget || aEvent.target,
      XPathResult.BOOLEAN_TYPE
    ).booleanValue;
}

function isEventFiredOnClickable(aEvent) {
  return evaluateXPath(
      'ancestor-or-self::*[contains(" button scrollbar textbox ", concat(" ", local-name(), " "))]',
      aEvent.originalTarget || aEvent.target,
      XPathResult.BOOLEAN_TYPE
    ).booleanValue;
}

function isEventFiredOnScrollbar(aEvent) {
  return evaluateXPath(
      'ancestor-or-self::*[local-name()="scrollbar" or local-name()="nativescrollbar"]',
      aEvent.originalTarget || aEvent.target,
      XPathResult.BOOLEAN_TYPE
    ).booleanValue;
}

function isTabInViewport(aTab) {
  if (!aTab)
    return false;

  if (isPinned(aTab))
    return true;

  var tabRect = aTab.getBoundingClientRect();
  var containerRect = aTab.parentNode.getBoundingClientRect();

  return (
    containerRect.top >= barBox.top &&
    containerRect.bottom <= barBox.bottom
  );
}

function onMouseDown(aEvent) {
  var tab = getTabFromEvent(aEvent);
  if (isAccelAction(aEvent)) {
    if (tab/* && warnAboutClosingTabSubtreeOf(tab)*/) {
      log('middle-click to close');
      browser.runtime.sendMessage({
        type:      kCOMMAND_REMOVE_TAB,
        windowId:  gTargetWindow,
        tab:       tab.id
      });
      aEvent.stopPropagation();
      aEvent.preventDefault();
    }
    else if (isEventFiredOnNewTabButton(aEvent)) {
      aEvent.stopPropagation();
      aEvent.preventDefault();
      handleNewTabAction(aEvent);
    }
    return;
  }

  tab = tab || getTabFromTabbarEvent(aEvent);
  if (!tab)
    return;

  if (isEventFiredOnTwisty(aEvent)) {
    log('clicked on twisty');
    aEvent.stopPropagation();
    aEvent.preventDefault();
    if (hasChildTabs(tab))
      browser.runtime.sendMessage({
        type:      kCOMMAND_PUSH_SUBTREE_COLLAPSED_STATE,
        windowId:  gTargetWindow,
        tab:       tab.id,
        collapsed: !isSubtreeCollapsed(tab),
        manualOperation: true
      });
    return;
  }

  if (isEventFiredOnClosebox(aEvent) &&
      aEvent.button == 0) {
    log('mousedown on closebox');
    return;
  }

  browser.runtime.sendMessage({
    type:      kCOMMAND_SELECT_TAB,
    windowId:  gTargetWindow,
    tab:       tab.id
  });
}

function onClick(aEvent) {
  if (isEventFiredOnNewTabButton(aEvent)) {
    aEvent.stopPropagation();
    aEvent.preventDefault();
    handleNewTabAction(aEvent);
    return;
  }

  if (!isEventFiredOnClosebox(aEvent))
    return;

  aEvent.stopPropagation();
  aEvent.preventDefault();

  log('clicked on closebox');
  var tab = getTabFromEvent(aEvent);
  //if (!warnAboutClosingTabSubtreeOf(tab)) {
  //  aEvent.stopPropagation();
  //  aEvent.preventDefault();
  //  return;
  //}
  browser.runtime.sendMessage({
    type:      kCOMMAND_REMOVE_TAB,
    windowId:  gTargetWindow,
    tab:       tab.id
  });
}

function handleNewTabAction(aEvent) {
  browser.runtime.sendMessage({
    type:      kCOMMAND_NEW_TAB,
    windowId:  gTargetWindow,
    accel:     isAccelAction(aEvent)
  });
}

function onDblClick(aEvent) {
  if (isEventFiredOnNewTabButton(aEvent) ||
      getTabFromEvent(aEvent))
    return;

  aEvent.stopPropagation();
  aEvent.preventDefault();
  handleNewTabAction(aEvent);
}
