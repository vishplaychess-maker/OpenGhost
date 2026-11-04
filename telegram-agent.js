(() => {
'use strict';

// The page's side of Telegram (desktop/telegram.js keeps the bot): a message from an allowed user runs the agent turn in
// that user's Telegram chat, and the reply goes back to the bot. Only the app's own window does this; the quick chat's
// window leaves the bot to it. Messages are taken one after another, so a turn on the same chat is never overtaken.
const bridge = window.openghost?.telegram;
if (!bridge || window.openghost?.quick) return;

let chain = Promise.resolve();
bridge.onAsk(request => {
 chain = chain.then(() => chat.answerTelegram(request)).catch(() => {
  bridge.answer(request.id, '', I18n.t('telegram.failed'));
 });
});

// The chats are read: the page can make a Telegram chat and run its agent.
library.ready.then(() => bridge.ready()).catch(() => {});
})();
