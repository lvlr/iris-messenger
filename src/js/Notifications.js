import Helpers from './Helpers.js';
import Session from './Session.js';
import { route } from 'preact-router';
import State from './State.js';
import _ from 'lodash';
import iris from 'iris-lib';
import Gun from 'gun';
import $ from 'jquery';

const notificationSound = new Audio('../../assets/audio/notification.mp3');
let loginTime;
let unseenTotal;
const webPushSubscriptions = {};

function desktopNotificationsEnabled() {
  return window.Notification && Notification.permission === 'granted';
}

function enableDesktopNotifications() {
  if (window.Notification) {
    Notification.requestPermission(() => {
      if (Notification.permission === 'granted' || Notification.permission === 'denied') {
        $('#enable-notifications-prompt').slideUp();
      }
      if (Notification.permission === 'granted') {
        subscribeToWebPush();
      }
    });
  }
}

function notifyMsg(msg, info, pub) {
  function shouldNotify() {
    if (msg.timeObj < loginTime) { return false; }
    if (info.selfAuthored) { return false; }
    if (document.visibilityState === 'visible') { return false; }
    if (Session.channels[pub].notificationSetting === 'nothing') { return false; }
    if (Session.channels[pub].notificationSetting === 'mentions' && !msg.text.includes(Session.getMyName())) { return false; }
    return true;
  }
  function shouldDesktopNotify() {
    if (!desktopNotificationsEnabled()) { return false; }
    return shouldNotify();
  }
  function shouldAudioNotify() {
    return shouldNotify();
  }
  if (shouldAudioNotify()) {
    notificationSound.play();
  }
  if (shouldDesktopNotify()) {
    let body, title;
    if (Session.channels[pub].uuid) {
      title = Session.channels[pub].participantProfiles[info.from].name;
      body = `${name}: ${msg.text}`;
    } else {
      title = 'Message'
      body = msg.text;
    }
    body = Helpers.truncateString(body, 50);
    let desktopNotification = new Notification(title, { // TODO: replace with actual name
      icon: '/assets/img/icon128.png',
      body,
      silent: true
    });
    desktopNotification.onclick = function() {
      route(`/chat/${  pub}`);
      window.focus();
    };
  }
}

function changeChatUnseenCount(chatId, change) {
  const chat = Session.channels[chatId];
  if (!chat) return;
  const chatNode = State.local.get('channels').get(chatId);
  if (change) {
    unseenTotal += change;
    chat.unseen += change;
  } else {
    unseenTotal = unseenTotal - (chat.unseen || 0);
    chat.unseen = 0;
  }
  chatNode.get('unseen').put(chat.unseen);
  unseenTotal = unseenTotal >= 0 ? unseenTotal : 0;
  State.local.get('unseenTotal').put(unseenTotal);
}

const publicVapidKey = 'BMqSvZArOIdn7vGkYplSpkZ70-Qt8nhYbey26WVa3LF3SwzblSzm3n3HHycpNkAKVq7MCkrzFuTFs_en7Y_J2MI';

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding)
    .replace(/-/g, '+')
    .replace(/_/g, '/');

  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

async function subscribe(reg) {
  try {
    const subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicVapidKey)
    });
    addWebPushSubscription(subscription);
  } catch (e) {
    console.error('web push subscription error', e);
  }
}

async function subscribeToWebPush() {
  if (!desktopNotificationsEnabled() || !navigator.serviceWorker) { return false; }
  await navigator.serviceWorker.ready;
  const reg = await navigator.serviceWorker.getRegistration();
  reg.active.postMessage({key: Session.getKey()});
  const sub = await reg.pushManager.getSubscription();
  sub ? addWebPushSubscription(sub) : subscribe(reg);
}

const addWebPushSubscriptionsToChats = _.debounce(() => {
  const arr = Object.values(webPushSubscriptions);
  Object.values(Session.channels).forEach(channel => {
    if (channel.put) {
      channel.put('webPushSubscriptions', arr);
    }
  });
}, 5000);

function removeSubscription(hash) {
  delete webPushSubscriptions[hash];
  State.public.user().get('webPushSubscriptions').get(hash).put(null);
  addWebPushSubscriptionsToChats();
}

async function addWebPushSubscription(s, saveToGun = true) {
  const myKey = Session.getKey();
  const mySecret = await Gun.SEA.secret(myKey.epub, myKey);
  const enc = await Gun.SEA.encrypt(s, mySecret);
  const hash = await iris.util.getHash(JSON.stringify(s));
  if (saveToGun) {
    State.public.user().get('webPushSubscriptions').get(hash).put(enc);
  }
  webPushSubscriptions[hash] = s;
  addWebPushSubscriptionsToChats();
}

async function getWebPushSubscriptions() {
  const myKey = Session.getKey();
  const mySecret = await Gun.SEA.secret(myKey.epub, myKey);
  State.public.user().get('webPushSubscriptions').map().on(async enc => {
    if (!enc) { return; }
    const s = await Gun.SEA.decrypt(enc, mySecret);
    addWebPushSubscription(s, false);
  });
}

function getEpub(user) {
  return new Promise(resolve => {
    State.public.user(user).get('epub').on(async (epub,k,x,e) => {
      if (epub) {
        e.off();
        resolve(epub);
      }
    });
  });
}

function subscribeToIrisNotifications() {
  let notificationsSeenTime;
  State.public.user().get('notificationsSeenTime').on(v => notificationsSeenTime = v);
  const setNotificationsSeenTime = _.debounce(() => {
    State.public.user().get('notificationsSeenTime').put(new Date().toISOString());
  }, 1000);
  setTimeout(() => {
    State.group().on(`notifications/${Session.getPubKey()}`, async (encryptedNotification, k, x, e, from) => {
      const epub = await getEpub(from);
      const secret = await Gun.SEA.secret(epub, Session.getKey());
      const notification = await Gun.SEA.decrypt(encryptedNotification, secret);
      if (!notification) { return; }
      const name = await State.public.user(from).get('profile').get('name').once();
      setNotificationsSeenTime();
      console.log('decrypted notification', notification, 'from', name, from);
      if (notificationsSeenTime < notification.time) {
        console.log('was new!');
        const action = notification.action === 'like' ? 'liked' : 'replied to';
        let desktopNotification = new Notification(`${name} ${action} your post`, {
          icon: '/assets/img/icon128.png',
          body: `${name} ${action} your post`,
          silent: true
        });
        desktopNotification.onclick = function() {
          route(`/post/${notification.target}`);
          window.focus();
        };
      }
    });
  }, 2000);
}

async function sendIrisNotification(recipient, notification) {
  if (!(recipient && notification)) { return; } // TODO: use typescript or sth :D
  if (typeof notification === 'object') { notification.time = new Date().toISOString() }
  const epub = await getEpub(recipient);
  const secret = await Gun.SEA.secret(epub, Session.getKey());
  const enc = await Gun.SEA.encrypt(notification, secret);
  State.public.user().get('notifications').get(recipient).put(enc);
}

function init() {
  loginTime = new Date();
  unseenTotal = 0;
}

export default {init, notifyMsg, subscribeToIrisNotifications, sendIrisNotification, enableDesktopNotifications, changeChatUnseenCount, webPushSubscriptions, subscribeToWebPush, getWebPushSubscriptions, removeSubscription};
