"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  Bold,
  Code2,
  EyeOff,
  ExternalLink,
  Italic,
  Link2,
  Quote,
  RemoveFormatting,
  Strikethrough,
  Underline,
  Unlink,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { serializeEditableText } from "@/lib/editable-text.mjs";
import {
  normalizeRichTextEntities,
  normalizeRichTextUrl,
  sliceRichTextEntities,
  type RichTextEntity,
  type RichTextEntityType,
} from "@/lib/rich-text.mjs";
import { toTelegramHtml } from "@/lib/telegram-format.mjs";

type RichTextValue = { text: string; formatting: RichTextEntity[] };
type LinkForm = {
  text: string;
  url: string;
  existing: boolean;
};
type SelectionMenu = { top: number; left: number };

const INLINE_FORMATS = [
  { type: "bold" as const, label: "Жирный", icon: Bold, shortcut: "Ctrl/Cmd + B" },
  { type: "italic" as const, label: "Курсив", icon: Italic, shortcut: "Ctrl/Cmd + I" },
  { type: "underline" as const, label: "Подчёркнутый", icon: Underline, shortcut: "Ctrl/Cmd + U" },
  { type: "strikethrough" as const, label: "Зачёркнутый", icon: Strikethrough },
  { type: "code" as const, label: "Моноширинный", icon: Code2 },
  { type: "spoiler" as const, label: "Скрытый текст", icon: EyeOff },
  { type: "blockquote" as const, label: "Цитата", icon: Quote },
] as const;

const FORMAT_TAGS: Record<Exclude<RichTextEntityType, "link">, string[]> = {
  bold: ["B", "STRONG"],
  italic: ["I", "EM"],
  underline: ["U", "INS"],
  strikethrough: ["S", "STRIKE", "DEL"],
  code: ["CODE", "PRE"],
  spoiler: ["TG-SPOILER"],
  blockquote: ["BLOCKQUOTE"],
};

function signature(value: RichTextValue) {
  return `${value.text}\0${JSON.stringify(value.formatting)}`;
}

function isBlock(element: Element) {
  return ["DIV", "P", "LI"].includes(element.tagName);
}

function elementFormats(element: HTMLElement): Array<Exclude<RichTextEntityType, "link">> {
  const result: Array<Exclude<RichTextEntityType, "link">> = [];
  for (const [type, tags] of Object.entries(FORMAT_TAGS) as Array<[
    Exclude<RichTextEntityType, "link">,
    string[],
  ]>) {
    if (tags.includes(element.tagName)) result.push(type);
  }
  const style = element.getAttribute("style")?.toLowerCase() ?? "";
  if (/font-weight\s*:\s*(?:bold|[6-9]00)/u.test(style)) result.push("bold");
  if (/font-style\s*:\s*italic/u.test(style)) result.push("italic");
  if (/text-decoration[^;]*(?:underline)/u.test(style)) result.push("underline");
  if (/text-decoration[^;]*(?:line-through)/u.test(style)) result.push("strikethrough");
  return [...new Set(result)];
}

function serializeEditor(root: HTMLElement): RichTextValue {
  const formatting: RichTextEntity[] = [];
  const cleanText = serializeEditableText(root, (node, start, end) => {
    if (!(node instanceof HTMLElement)) return;
    if (end > start) {
      for (const type of elementFormats(node)) {
        formatting.push({ type, offset: start, length: end - start });
      }
      if (node.tagName === "A") {
        try {
          formatting.push({
            type: "link",
            offset: start,
            length: end - start,
            url: normalizeRichTextUrl(node.getAttribute("href")),
          });
        } catch {
          // Unsafe pasted links keep their visible text and lose only the link entity.
        }
      }
    }
  });
  return {
    text: cleanText,
    formatting: normalizeRichTextEntities(
      cleanText,
      sliceRichTextEntities(formatting, 0, cleanText.length),
    ),
  };
}

function closestFormatElement(
  node: Node | null,
  root: HTMLElement,
  type: Exclude<RichTextEntityType, "link">,
) {
  let element = node instanceof HTMLElement ? node : node?.parentElement ?? null;
  while (element && element !== root) {
    if (elementFormats(element).includes(type)) return element;
    element = element.parentElement;
  }
  return null;
}

function formatElement(document: Document, type: Exclude<RichTextEntityType, "link">) {
  if (type === "bold") return document.createElement("strong");
  if (type === "italic") return document.createElement("em");
  if (type === "underline") return document.createElement("u");
  if (type === "strikethrough") return document.createElement("s");
  if (type === "code") return document.createElement("code");
  if (type === "blockquote") return document.createElement("blockquote");
  return document.createElement("tg-spoiler");
}

function unwrap(element: HTMLElement) {
  const parent = element.parentNode;
  if (!parent) return;
  while (element.firstChild) parent.insertBefore(element.firstChild, element);
  parent.removeChild(element);
}

function selectionInside(root: HTMLElement, selection: Selection | null) {
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  return root.contains(range.commonAncestorContainer) ? range : null;
}

function safePastedFragment(document: Document, html: string) {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const copy = (node: Node, isLast = false): Node | DocumentFragment | null => {
    if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.nodeValue ?? "");
    if (!(node instanceof HTMLElement)) return null;
    if (["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "META", "LINK"].includes(node.tagName)) {
      return null;
    }
    if (node.tagName === "BR") return document.createElement("br");
    const fragment = document.createDocumentFragment();
    const children = [...node.childNodes];
    children.forEach((child, index) => {
      const clean = copy(child, index === children.length - 1);
      if (clean) fragment.append(clean);
    });
    let output: Node | DocumentFragment = fragment;
    const formats = elementFormats(node);
    for (const type of formats) {
      const wrapper = formatElement(document, type);
      wrapper.append(output);
      output = wrapper;
    }
    if (node.tagName === "A") {
      try {
        const anchor = document.createElement("a");
        anchor.href = normalizeRichTextUrl(node.getAttribute("href"));
        anchor.append(output);
        output = anchor;
      } catch {
        // Keep text when the source supplied an unsafe scheme.
      }
    }
    if (isBlock(node) && !isLast) {
      const withBreak = document.createDocumentFragment();
      withBreak.append(output, document.createElement("br"));
      output = withBreak;
    }
    return output;
  };
  const result = document.createDocumentFragment();
  const children = [...parsed.body.childNodes];
  children.forEach((child, index) => {
    const clean = copy(child, index === children.length - 1);
    if (clean) result.append(clean);
  });
  return result;
}

function insertAtRange(range: Range, node: Node) {
  const lastInserted = node.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? node.lastChild : node;
  range.deleteContents();
  range.insertNode(node);
  if (lastInserted) range.setStartAfter(lastInserted);
  range.collapse(true);
  const selection = node.ownerDocument?.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function ToolbarButton({
  label,
  shortcut,
  active = false,
  disabled,
  onPress,
  children,
}: {
  label: string;
  shortcut?: string;
  active?: boolean;
  disabled?: boolean;
  onPress: () => void;
  children: React.ReactNode;
}) {
  const accessibleLabel = shortcut ? `${label}, ${shortcut}` : label;
  return (
    <button
      type="button"
      aria-label={accessibleLabel}
      aria-pressed={active}
      title={accessibleLabel}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onPress}
      className={cn(
        "inline-flex size-10 shrink-0 items-center justify-center rounded-xs text-text-2",
        "transition-[color,background-color,scale] duration-150 active:scale-[0.96]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface",
        "disabled:cursor-not-allowed disabled:opacity-40",
        active ? "bg-info-soft text-info-text" : "hover:bg-surface hover:text-text",
      )}
    >
      {children}
    </button>
  );
}

export function RichTextEditor({
  id,
  value,
  formatting,
  onChange,
  placeholder,
  readOnly = false,
  busy = false,
  invalid = false,
  ariaDescribedBy,
  className,
  onKeyDown,
  editorRef,
}: {
  id: string;
  value: string;
  formatting: RichTextEntity[];
  onChange: (value: RichTextValue) => void;
  placeholder?: string;
  readOnly?: boolean;
  busy?: boolean;
  invalid?: boolean;
  ariaDescribedBy?: string;
  className?: string;
  onKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  editorRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const internalRef = useRef<HTMLDivElement>(null);
  const rootRef = editorRef ?? internalRef;
  const savedRangeRef = useRef<Range | null>(null);
  const existingLinkRef = useRef<HTMLAnchorElement | null>(null);
  const emittedRef = useRef("");
  const linkInputRef = useRef<HTMLInputElement>(null);
  const [active, setActive] = useState<Set<RichTextEntityType>>(() => new Set());
  const [linkForm, setLinkForm] = useState<LinkForm | null>(null);
  const [linkError, setLinkError] = useState("");
  const [selectionMenu, setSelectionMenu] = useState<SelectionMenu | null>(null);
  const [status, setStatus] = useState("");

  const emitChange = () => {
    const root = rootRef.current;
    if (!root) return;
    const next = serializeEditor(root);
    emittedRef.current = signature(next);
    root.dataset.empty = next.text ? "false" : "true";
    onChange(next);
  };

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const next = { text: value, formatting: normalizeRichTextEntities(value, formatting) };
    const nextSignature = signature(next);
    if (nextSignature === emittedRef.current) return;
    root.innerHTML = toTelegramHtml(value, next.formatting);
    root.dataset.empty = value ? "false" : "true";
    emittedRef.current = nextSignature;
  }, [formatting, rootRef, value]);

  useEffect(() => {
    if (linkForm) linkInputRef.current?.focus();
  }, [linkForm]);

  const rememberSelection = () => {
    const root = rootRef.current;
    if (!root) return null;
    const selection = document.getSelection();
    const range = selectionInside(root, selection);
    if (!range) return null;
    savedRangeRef.current = range.cloneRange();
    return range;
  };

  const restoreSelection = () => {
    const range = savedRangeRef.current;
    const root = rootRef.current;
    if (!range || !root || !root.contains(range.commonAncestorContainer)) return null;
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return range;
  };

  const updateSelectionState = () => {
    const root = rootRef.current;
    if (!root || linkForm) return;
    const selection = document.getSelection();
    const range = selectionInside(root, selection);
    if (!range) {
      setSelectionMenu(null);
      return;
    }
    savedRangeRef.current = range.cloneRange();
    const next = new Set<RichTextEntityType>();
    for (const item of INLINE_FORMATS) {
      if (closestFormatElement(range.commonAncestorContainer, root, item.type)) next.add(item.type);
    }
    const anchorNode = range.commonAncestorContainer instanceof HTMLElement
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
    if (anchorNode?.closest("a") && root.contains(anchorNode.closest("a"))) next.add("link");
    setActive(next);
    if (range.collapsed) {
      setSelectionMenu(null);
    } else {
      const rect = range.getBoundingClientRect();
      if (rect.width || rect.height) {
        setSelectionMenu({
          top: Math.max(8, rect.top - 52),
          left: Math.min(window.innerWidth - 164, Math.max(164, rect.left + rect.width / 2)),
        });
      }
    }
  };

  useEffect(() => {
    document.addEventListener("selectionchange", updateSelectionState);
    window.addEventListener("resize", updateSelectionState);
    return () => {
      document.removeEventListener("selectionchange", updateSelectionState);
      window.removeEventListener("resize", updateSelectionState);
    };
  });

  const toggleFormat = (type: Exclude<RichTextEntityType, "link">) => {
    if (readOnly) return;
    const root = rootRef.current;
    const range = restoreSelection() ?? rememberSelection();
    if (!root || !range || range.collapsed) {
      setStatus("Сначала выделите текст для форматирования.");
      return;
    }
    const existing = closestFormatElement(range.commonAncestorContainer, root, type);
    if (existing) {
      unwrap(existing);
    } else {
      const wrapper = formatElement(document, type);
      wrapper.append(range.extractContents());
      range.insertNode(wrapper);
      range.selectNodeContents(wrapper);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      savedRangeRef.current = range.cloneRange();
    }
    setStatus(existing ? `${INLINE_FORMATS.find((item) => item.type === type)?.label} выключен.` : `${INLINE_FORMATS.find((item) => item.type === type)?.label} применён.`);
    emitChange();
    updateSelectionState();
  };

  const openLinkForm = (anchor: HTMLAnchorElement | null = null) => {
    if (readOnly) return;
    const root = rootRef.current;
    let range = rememberSelection() ?? restoreSelection();
    if (!root) return;
    if (!range) {
      root.focus();
      range = document.createRange();
      range.selectNodeContents(root);
      range.collapse(false);
      savedRangeRef.current = range.cloneRange();
    }
    if (anchor) {
      range = document.createRange();
      range.selectNodeContents(anchor);
      savedRangeRef.current = range.cloneRange();
    }
    const selectedText = range && !range.collapsed ? range.toString() : "";
    setLinkError("");
    setLinkForm({
      text: anchor?.textContent ?? selectedText,
      url: anchor?.getAttribute("href") ?? "",
      existing: Boolean(anchor),
    });
    existingLinkRef.current = anchor;
    setSelectionMenu(null);
  };

  const closeLinkForm = () => {
    setLinkForm(null);
    existingLinkRef.current = null;
    setLinkError("");
    rootRef.current?.focus();
  };

  const applyLink = () => {
    if (!linkForm) return;
    const label = linkForm.text.trim();
    if (!label) {
      setLinkError("Введите текст ссылки.");
      return;
    }
    let url: string;
    try {
      url = normalizeRichTextUrl(linkForm.url);
    } catch {
      setLinkError("Введите корректную ссылку.");
      return;
    }
    const existing = existingLinkRef.current;
    if (existing && rootRef.current?.contains(existing)) {
      existing.href = url;
      existing.textContent = label;
    } else {
      const range = restoreSelection();
      if (!range) {
        setLinkError("Вернитесь в текст и выберите место для ссылки.");
        return;
      }
      const anchor = document.createElement("a");
      anchor.href = url;
      if (!range.collapsed && range.toString().trim() === label) anchor.append(range.extractContents());
      else anchor.textContent = label;
      range.deleteContents();
      range.insertNode(anchor);
      range.setStartAfter(anchor);
      range.collapse(true);
    }
    emitChange();
    setStatus("Ссылка добавлена.");
    closeLinkForm();
  };

  const removeLink = () => {
    const existing = existingLinkRef.current;
    if (!linkForm?.existing || !existing || !rootRef.current?.contains(existing)) return;
    unwrap(existing);
    emitChange();
    setStatus("Ссылка удалена, текст сохранён.");
    closeLinkForm();
  };

  const clearFormatting = () => {
    if (readOnly) return;
    const range = restoreSelection() ?? rememberSelection();
    if (!range || range.collapsed) {
      setStatus("Сначала выделите текст, с которого нужно снять форматирование.");
      return;
    }
    const text = range.toString();
    const node = document.createTextNode(text);
    range.deleteContents();
    range.insertNode(node);
    range.selectNodeContents(node);
    savedRangeRef.current = range.cloneRange();
    emitChange();
    setStatus("Форматирование удалено.");
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    if (readOnly) return;
    event.preventDefault();
    const root = rootRef.current;
    const range = rememberSelection() ?? restoreSelection();
    if (!root || !range) return;
    const plain = event.clipboardData.getData("text/plain");
    const html = event.clipboardData.getData("text/html");
    let normalizedUrl: string | null = null;
    try {
      normalizedUrl = plain && !/\s/u.test(plain.trim()) ? normalizeRichTextUrl(plain) : null;
    } catch {
      normalizedUrl = null;
    }
    if (normalizedUrl && !range.collapsed) {
      const anchor = document.createElement("a");
      anchor.href = normalizedUrl;
      anchor.append(range.extractContents());
      range.insertNode(anchor);
      range.selectNodeContents(anchor);
    } else if (normalizedUrl) {
      const anchor = document.createElement("a");
      anchor.href = normalizedUrl;
      anchor.textContent = plain.trim();
      insertAtRange(range, anchor);
    } else if (html) {
      insertAtRange(range, safePastedFragment(document, html));
    } else {
      insertAtRange(range, document.createTextNode(plain));
    }
    savedRangeRef.current = range.cloneRange();
    emitChange();
  };

  const handleEditorKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && linkForm) {
      event.preventDefault();
      closeLinkForm();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && !event.altKey) {
      const key = event.key.toLowerCase();
      const shortcut = key === "b" ? "bold" : key === "i" ? "italic" : key === "u" ? "underline" : null;
      if (shortcut) {
        event.preventDefault();
        rememberSelection();
        toggleFormat(shortcut);
        return;
      }
      if (key === "k") {
        event.preventDefault();
        openLinkForm();
        return;
      }
    }
    onKeyDown?.(event);
  };

  let openLinkHref: string | null = null;
  try {
    openLinkHref = linkForm?.existing ? normalizeRichTextUrl(linkForm.url) : null;
  } catch {
    openLinkHref = null;
  }

  const formatButtons = (compact = false) => (
    <>
      {INLINE_FORMATS.slice(0, compact ? 3 : INLINE_FORMATS.length).map((item) => {
        const Icon = item.icon;
        return (
          <ToolbarButton
            key={item.type}
            label={item.label}
            shortcut={"shortcut" in item ? item.shortcut : undefined}
            active={active.has(item.type)}
            disabled={readOnly}
            onPress={() => toggleFormat(item.type)}
          >
            <Icon className="size-[18px]" strokeWidth={1.75} aria-hidden />
          </ToolbarButton>
        );
      })}
      <ToolbarButton
        label="Добавить ссылку"
        shortcut="Ctrl/Cmd + K"
        active={active.has("link")}
        disabled={readOnly}
        onPress={() => openLinkForm()}
      >
        <Link2 className="size-[18px]" strokeWidth={1.75} aria-hidden />
      </ToolbarButton>
      {!compact && (
        <ToolbarButton label="Удалить форматирование" disabled={readOnly} onPress={clearFormatting}>
          <RemoveFormatting className="size-[18px]" strokeWidth={1.75} aria-hidden />
        </ToolbarButton>
      )}
    </>
  );

  return (
    <div className={cn("relative overflow-visible rounded-sm border border-line bg-surface", invalid && "border-danger", className)}>
      <div
        role="toolbar"
        aria-label="Форматирование текста"
        className="flex max-w-full items-center gap-0.5 overflow-x-auto border-b border-line px-2 py-1.5"
      >
        {formatButtons()}
      </div>

      {linkForm && (
        <div
          role="dialog"
          aria-label={linkForm.existing ? "Изменить ссылку" : "Добавить ссылку"}
          className="space-y-3 border-b border-line bg-surface-inset p-3"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              closeLinkForm();
            }
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-[13px] font-medium text-text-2">
              <span>Текст ссылки</span>
              <input
                value={linkForm.text}
                onChange={(event) => setLinkForm({ ...linkForm, text: event.target.value })}
                className="h-11 w-full rounded-xs border border-line bg-surface px-3 text-[16px] text-text focus:border-brand focus:outline-none focus-visible:ring-4 focus-visible:ring-brand/15 sm:text-[14px]"
              />
            </label>
            <label className="space-y-1 text-[13px] font-medium text-text-2">
              <span>Адрес</span>
              <input
                ref={linkInputRef}
                type="url"
                inputMode="url"
                value={linkForm.url}
                aria-invalid={Boolean(linkError) || undefined}
                aria-describedby={linkError ? `${id}-link-error` : undefined}
                placeholder="example.com"
                onChange={(event) => {
                  setLinkError("");
                  setLinkForm({ ...linkForm, url: event.target.value });
                }}
                className="h-11 w-full rounded-xs border border-line bg-surface px-3 text-[16px] text-text placeholder:text-text-3 focus:border-brand focus:outline-none focus-visible:ring-4 focus-visible:ring-brand/15 sm:text-[14px]"
              />
            </label>
          </div>
          {linkError && <p id={`${id}-link-error`} role="alert" className="text-[13px] font-medium text-danger-text">{linkError}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={applyLink} className="inline-flex min-h-10 items-center rounded-xs bg-brand px-4 text-[14px] font-semibold text-white transition-transform active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface">
              {linkForm.existing ? "Сохранить ссылку" : "Добавить ссылку"}
            </button>
            <button type="button" onClick={closeLinkForm} className="inline-flex min-h-10 items-center rounded-xs px-3 text-[14px] font-semibold text-text-2 transition-transform active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface">
              Отмена
            </button>
            {linkForm.existing && (
              <>
                {openLinkHref && (
                  <a href={openLinkHref} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-10 items-center gap-1.5 rounded-xs px-3 text-[14px] font-semibold text-info-text underline decoration-from-font underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface">
                    <ExternalLink className="size-4" aria-hidden /> Открыть
                  </a>
                )}
                <button type="button" onClick={removeLink} className="inline-flex min-h-10 items-center gap-1.5 rounded-xs px-3 text-[14px] font-semibold text-danger-text transition-transform active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger focus-visible:ring-offset-2 focus-visible:ring-offset-surface">
                  <Unlink className="size-4" aria-hidden /> Удалить ссылку
                </button>
              </>
            )}
          </div>
        </div>
      )}

      <div
        id={id}
        ref={rootRef}
        role="textbox"
        aria-label="Текст публикации"
        aria-multiline="true"
        aria-readonly={readOnly || undefined}
        aria-busy={busy || undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={ariaDescribedBy}
        contentEditable={!readOnly}
        tabIndex={readOnly ? 0 : undefined}
        suppressContentEditableWarning
        spellCheck
        data-placeholder={placeholder}
        data-empty={value ? "false" : "true"}
        onInput={emitChange}
        onPaste={handlePaste}
        onKeyDown={handleEditorKeyDown}
        onMouseUp={rememberSelection}
        onKeyUp={rememberSelection}
        onClick={(event) => {
          const target = event.target instanceof Element ? event.target.closest("a") : null;
          if (target instanceof HTMLAnchorElement && rootRef.current?.contains(target)) {
            event.preventDefault();
            if (readOnly) {
              try {
                window.open(normalizeRichTextUrl(target.getAttribute("href")), "_blank", "noopener,noreferrer");
              } catch {
                setStatus("Ссылка недоступна.");
              }
              return;
            }
            openLinkForm(target);
          }
        }}
        className={cn(
          "rich-text-editor min-h-[180px] w-full overflow-y-auto p-4 text-[16px] leading-relaxed text-text sm:min-h-[280px]",
          "whitespace-pre-wrap break-words focus:outline-none focus-visible:ring-4 focus-visible:ring-brand/15",
          readOnly && "cursor-default bg-surface-inset",
          busy && "cursor-progress",
        )}
      />

      {selectionMenu && !linkForm && (
        <div
          role="toolbar"
          aria-label="Форматирование выделенного текста"
          style={{ top: selectionMenu.top, left: selectionMenu.left }}
          className="fixed z-50 hidden -translate-x-1/2 items-center gap-0.5 rounded-sm border border-line bg-surface p-1 shadow-lg sm:flex"
        >
          {formatButtons(true)}
        </div>
      )}
      <p role="status" aria-live="polite" className="sr-only">{status}</p>
    </div>
  );
}
