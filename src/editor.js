import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Image } from '@tiptap/extension-image';
import { TextAlign } from '@tiptap/extension-text-align';
import { TextStyleKit } from '@tiptap/extension-text-style';
import { Highlight } from '@tiptap/extension-highlight';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import { Placeholder } from '@tiptap/extensions';
import { h, toast, errMsg } from './util.js';
import { icon } from './icons.js';
import { uploadImage, imageFiles } from './media.js';

// Images keep their storage path in data-path; src is a short-lived signed URL.
const StoredImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      path: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-path'),
        renderHTML: (a) => (a.path ? { 'data-path': a.path } : {}),
      },
    };
  },
});

const COLORS = ['#e5e7eb', '#f87171', '#fb923c', '#facc15', '#4ade80', '#38bdf8', '#a78bfa', '#f472b6', '#9ca3af'];
const MARKS = ['#fde68a', '#bbf7d0', '#bae6fd', '#fbcfe8', '#fecaca', '#ddd6fe'];
const SIZES = ['12px', '14px', '16px', '18px', '22px', '28px', '36px'];

async function insertFiles(editor, files, pos) {
  for (const file of files) {
    toast(`Uploading ${file.name || 'image'}…`);
    try {
      const { path, url } = await uploadImage(file);
      const chain = editor.chain().focus();
      if (pos != null) chain.insertContentAt(Math.min(pos, editor.state.doc.content.size), { type: 'image', attrs: { src: url, path } });
      else chain.setImage({ src: url, path });
      chain.run();
    } catch (e) {
      toast(`Image upload failed: ${errMsg(e)}`, 'error', 6000);
    }
  }
}

/**
 * Create a TipTap editor.
 * @param {HTMLElement} mount  element that receives toolbar + content
 * @param {{content?: string, compact?: boolean, placeholder?: string, onUpdate?: Function, onBlur?: Function}} opts
 */
export function createEditor(mount, { content = '', compact = false, placeholder = '', onUpdate, onBlur } = {}) {
  const toolbar = h('div.tb', { role: 'toolbar', 'aria-label': 'Formatting' });
  const surface = h('div.editor-surface');
  mount.append(toolbar, surface);

  const editor = new Editor({
    element: surface,
    content,
    extensions: [
      StarterKit.configure({
        link: {
          openOnClick: false,
          autolink: true,
          defaultProtocol: 'https',
          HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' },
        },
      }),
      StoredImage.configure({ allowBase64: false }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      TextStyleKit,
      Highlight.configure({ multicolor: true }),
      TaskList,
      TaskItem.configure({ nested: true }),
      TableKit.configure({ table: { resizable: !compact } }),
      Placeholder.configure({ placeholder }),
    ],
    editorProps: {
      attributes: { class: `prose${compact ? ' compact' : ''}`, spellcheck: 'true' },
      handlePaste(view, event) {
        const files = imageFiles(event.clipboardData);
        if (!files.length) return false;
        event.preventDefault();
        insertFiles(editor, files, view.state.selection.from);
        return true;
      },
      handleDrop(view, event) {
        const files = imageFiles(event.dataTransfer);
        if (!files.length) return false;
        event.preventDefault();
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
        insertFiles(editor, files, pos);
        return true;
      },
    },
    onUpdate: () => onUpdate?.(editor),
    onBlur: ({ event }) => onBlur?.(editor, event),
  });

  buildToolbar(toolbar, editor, compact);
  return editor;
}

function btn(name, title, run, isActive) {
  const b = h('button.tb-btn', { type: 'button', title, 'aria-label': title }, icon(name));
  b.addEventListener('mousedown', (e) => e.preventDefault()); // keep editor selection
  b.addEventListener('click', run);
  b._active = isActive;
  return b;
}

function swatchMenu(name, title, colors, apply, clear) {
  const wrap = h('div.tb-menu');
  const trigger = h('button.tb-btn', { type: 'button', title, 'aria-label': title, 'aria-haspopup': 'true' }, icon(name));
  const pop = h('div.tb-pop.swatches', { hidden: true });
  for (const c of colors) {
    const s = h('button.swatch', { type: 'button', title: c, style: { background: c } });
    s.addEventListener('mousedown', (e) => e.preventDefault());
    s.addEventListener('click', () => { apply(c); pop.hidden = true; });
    pop.append(s);
  }
  const none = h('button.swatch.none', { type: 'button', title: 'Remove' }, '✕');
  none.addEventListener('mousedown', (e) => e.preventDefault());
  none.addEventListener('click', () => { clear(); pop.hidden = true; });
  pop.append(none);
  trigger.addEventListener('mousedown', (e) => e.preventDefault());
  trigger.addEventListener('click', () => {
    const open = pop.hidden;
    document.querySelectorAll('.tb-pop').forEach((p) => { p.hidden = true; });
    pop.hidden = !open;
  });
  wrap.append(trigger, pop);
  return wrap;
}

function buildToolbar(tb, editor, compact) {
  const c = () => editor.chain().focus();
  const sep = () => h('span.tb-sep');
  const items = [];

  if (!compact) {
    items.push(
      btn('undo', 'Undo (Ctrl+Z)', () => c().undo().run()),
      btn('redo', 'Redo (Ctrl+Y)', () => c().redo().run()),
      sep());
    const block = h('select.tb-select', { title: 'Text style', 'aria-label': 'Text style' },
      h('option', { value: 'p' }, 'Paragraph'),
      h('option', { value: '1' }, 'Heading 1'),
      h('option', { value: '2' }, 'Heading 2'),
      h('option', { value: '3' }, 'Heading 3'),
      h('option', { value: 'code' }, 'Code block'));
    block.addEventListener('change', () => {
      const v = block.value;
      if (v === 'p') c().setParagraph().run();
      else if (v === 'code') c().toggleCodeBlock().run();
      else c().toggleHeading({ level: Number(v) }).run();
    });
    block._sync = () => {
      block.value = editor.isActive('codeBlock') ? 'code'
        : [1, 2, 3].find((l) => editor.isActive('heading', { level: l }))?.toString() || 'p';
    };
    const size = h('select.tb-select.narrow', { title: 'Font size', 'aria-label': 'Font size' },
      h('option', { value: '' }, 'Size'), SIZES.map((s) => h('option', { value: s }, parseInt(s, 10))));
    size.addEventListener('change', () => {
      if (size.value) c().setFontSize(size.value).run(); else c().unsetFontSize().run();
    });
    size._sync = () => { size.value = editor.getAttributes('textStyle').fontSize || ''; };
    items.push(block, size, sep());
  }

  items.push(
    btn('bold', 'Bold (Ctrl+B)', () => c().toggleBold().run(), () => editor.isActive('bold')),
    btn('italic', 'Italic (Ctrl+I)', () => c().toggleItalic().run(), () => editor.isActive('italic')),
    btn('underline', 'Underline (Ctrl+U)', () => c().toggleUnderline().run(), () => editor.isActive('underline')),
    btn('strike', 'Strikethrough', () => c().toggleStrike().run(), () => editor.isActive('strike')));
  if (!compact) items.push(btn('code', 'Inline code', () => c().toggleCode().run(), () => editor.isActive('code')));
  items.push(
    swatchMenu('color', 'Text color', COLORS, (col) => c().setColor(col).run(), () => c().unsetColor().run()),
    swatchMenu('highlight', 'Highlight', MARKS, (col) => c().setHighlight({ color: col }).run(), () => c().unsetHighlight().run()),
    sep(),
    btn('bullet', 'Bullet list', () => c().toggleBulletList().run(), () => editor.isActive('bulletList')),
    btn('ordered', 'Numbered list', () => c().toggleOrderedList().run(), () => editor.isActive('orderedList')),
    btn('task', 'Checklist', () => c().toggleTaskList().run(), () => editor.isActive('taskList')));

  if (!compact) {
    items.push(
      sep(),
      btn('alignLeft', 'Align left', () => c().setTextAlign('left').run(), () => editor.isActive({ textAlign: 'left' })),
      btn('alignCenter', 'Align center', () => c().setTextAlign('center').run(), () => editor.isActive({ textAlign: 'center' })),
      btn('alignRight', 'Align right', () => c().setTextAlign('right').run(), () => editor.isActive({ textAlign: 'right' })),
      btn('alignJustify', 'Justify', () => c().setTextAlign('justify').run(), () => editor.isActive({ textAlign: 'justify' })),
      sep(),
      btn('quote', 'Quote', () => c().toggleBlockquote().run(), () => editor.isActive('blockquote')),
      btn('hr', 'Divider line', () => c().setHorizontalRule().run()),
      tableMenu(editor));
  }

  items.push(
    btn('link', 'Link (select text first)', () => {
      const prev = editor.getAttributes('link').href || '';
      const url = prompt('Link URL (leave empty to remove):', prev);
      if (url === null) return;
      if (!url.trim()) c().extendMarkRange('link').unsetLink().run();
      else c().extendMarkRange('link').setLink({ href: url.trim() }).run();
    }, () => editor.isActive('link')),
    btn('image', 'Insert image (or paste / drop one)', () => {
      const input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', multiple: true });
      input.addEventListener('change', () => insertFiles(editor, [...input.files]));
      input.click();
    }),
    btn('clear', 'Clear formatting', () => c().unsetAllMarks().clearNodes().run()));

  tb.append(...items);
  const sync = () => {
    for (const el of tb.querySelectorAll('.tb-btn')) {
      if (el._active) el.classList.toggle('on', !!el._active());
    }
    for (const el of tb.querySelectorAll('select')) el._sync?.();
  };
  editor.on('transaction', sync);
  sync();
}

function tableMenu(editor) {
  const wrap = h('div.tb-menu');
  const trigger = h('button.tb-btn', { type: 'button', title: 'Table', 'aria-label': 'Table', 'aria-haspopup': 'true' }, icon('table'));
  const c = () => editor.chain().focus();
  const act = (label, fn) => {
    const b = h('button.menu-item', { type: 'button' }, label);
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => { fn(); pop.hidden = true; });
    return b;
  };
  const pop = h('div.tb-pop.menu', { hidden: true },
    act('Insert 3×3 table', () => c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()),
    act('Add row below', () => c().addRowAfter().run()),
    act('Add column right', () => c().addColumnAfter().run()),
    act('Delete row', () => c().deleteRow().run()),
    act('Delete column', () => c().deleteColumn().run()),
    act('Toggle header row', () => c().toggleHeaderRow().run()),
    act('Merge / split cells', () => c().mergeOrSplit().run()),
    act('Delete table', () => c().deleteTable().run()));
  trigger.addEventListener('mousedown', (e) => e.preventDefault());
  trigger.addEventListener('click', () => {
    const open = pop.hidden;
    document.querySelectorAll('.tb-pop').forEach((p) => { p.hidden = true; });
    pop.hidden = !open;
  });
  wrap.append(trigger, pop);
  return wrap;
}

document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('.tb-menu')) document.querySelectorAll('.tb-pop').forEach((p) => { p.hidden = true; });
});
