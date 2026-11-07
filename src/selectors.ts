// LinkedIn does not publish stable DOM selectors. Keep these isolated for repairs.
// The check command reports counts without printing names, messages, or cookies.
export const S = {
  conversationList: '.msg-conversations-container__conversations-list, .msg-conversations-container',
  conversationRow: '.msg-conversation-listitem, .msg-conversation-card',
  conversationLink: 'a[href*="/messaging/thread/"]',
  participantName: '.msg-conversation-listitem__participant-names, .msg-conversation-card__participant-names, .msg-conversation-listitem__participant-name',
  thread: '.msg-thread, .msg-thread__content',
  event: '.msg-s-event-listitem',
  eventFallback: '.msg-s-message-list__event',
  body: '.msg-s-event-listitem__body, .msg-s-event__content, .msg-s-event-listitem__message-bubble',
  sender: '.msg-s-message-group__name, .msg-s-event-listitem__name, .msg-s-message-group__profile-link, .msg-s-event-listitem__profile-link',
  composer: '.msg-form__contenteditable[contenteditable="true"], [contenteditable="true"][role="textbox"]',
  sendButton: 'button.msg-form__send-button',
  invitationCard: '[data-local-invite-card], .invitation-card, .invitation-card-container, [data-view-name="invitation-card"]',
  invitationName: '.invitation-card__title, .invitation-card__name, a[href*="/in/"]',
};
