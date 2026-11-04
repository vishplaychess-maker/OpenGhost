(() => {
'use strict';

// The page's side of WhatsApp (desktop/whatsapp.js keeps the session): a message from an allowed number runs the agent
// turn in that number's WhatsApp chat, and the reply goes back through the session. Only the app's own window does
// this; the quick chat's window leaves WhatsApp to it. Messages are taken one after another, so a turn on the same
// chat is never overtaken.
const bridge = window.openghost?.whatsapp;
if (!bridge || window.openghost?.quick) return;

let chain = Promise.resolve();
bridge.onAsk(request => {
 chain = chain.then(() => chat.answerWhatsApp(request)).catch(() => {
  bridge.answer(request.id, '', I18n.t('whatsapp.failed'));
 });
});

// The chats are read: the page can make a WhatsApp chat and run its agent.
library.ready.then(() => bridge.ready()).catch(() => {});
})();
