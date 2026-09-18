import DOMPurify from 'dompurify';

// Every piece of stored rich text passes through here before it is shown
// outside the editor. Users can only see each other's content, but a
// compromised account must not be able to run script in someone else's tab.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer nofollow');
  }
});

export function sanitize(html) {
  return DOMPurify.sanitize(html || '', {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed'],
    ADD_ATTR: ['target'],
  });
}
