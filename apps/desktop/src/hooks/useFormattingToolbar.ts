import { useState, useRef } from 'react';
import type { MutableRefObject } from 'react';

// Floating formatting toolbar for the composer: tracks the current selection,
// positions the toolbar above it using a hidden mirror element, and wraps the
// selection in markdown markers.
export function useFormattingToolbar(
  inputRef: MutableRefObject<HTMLTextAreaElement | null>,
  input: string,
  setInput: (value: string) => void,
) {
  const [formatSel, setFormatSel] = useState<{ start: number; end: number } | null>(null);
  const [toolbarCoords, setToolbarCoords] = useState<{ top: number; left: number } | null>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);

  const applyFormat = (prefix: string, suffix = prefix) => {
    const ta = inputRef.current;
    if (!ta || !formatSel) return;
    const { start, end } = formatSel;
    const newValue =
      input.slice(0, start) + prefix + input.slice(start, end) + suffix + input.slice(end);
    setInput(newValue);
    setFormatSel(null);
    setToolbarCoords(null);
    requestAnimationFrame(() => {
      ta.focus();
      ta.selectionStart = start + prefix.length;
      ta.selectionEnd = end + prefix.length;
    });
  };

  const handleSelect = () => {
    const ta = inputRef.current;
    if (!ta) return;
    const { selectionStart, selectionEnd } = ta;
    if (selectionStart !== null && selectionEnd !== null && selectionStart !== selectionEnd) {
      setFormatSel({ start: selectionStart, end: selectionEnd });
      requestAnimationFrame(() => {
        const mirror = mirrorRef.current;
        if (!mirror) return;
        const style = getComputedStyle(ta);
        const taRect = ta.getBoundingClientRect();
        mirror.style.fontFamily = style.fontFamily;
        mirror.style.fontSize = style.fontSize;
        mirror.style.fontWeight = style.fontWeight;
        mirror.style.lineHeight = style.lineHeight;
        mirror.style.letterSpacing = style.letterSpacing;
        mirror.style.textTransform = style.textTransform;
        mirror.style.textIndent = style.textIndent;
        mirror.style.whiteSpace = style.whiteSpace || 'pre-wrap';
        mirror.style.wordBreak = style.wordBreak || 'break-word';
        mirror.style.overflowWrap = style.overflowWrap || 'break-word';
        mirror.style.boxSizing = style.boxSizing || 'border-box';
        mirror.style.padding = style.padding;
        mirror.style.width = style.width;
        mirror.textContent = '';
        const text = ta.value;
        mirror.appendChild(document.createTextNode(text.slice(0, selectionStart)));
        const span = document.createElement('span');
        span.textContent = text.slice(selectionStart, selectionEnd);
        mirror.appendChild(span);
        mirror.appendChild(document.createTextNode(text.slice(selectionEnd)));
        const mirrorRect = mirror.getBoundingClientRect();
        const spanRect = span.getBoundingClientRect();
        const scrollTop = ta.scrollTop;
        const scrollLeft = ta.scrollLeft;
        let top = taRect.top + (spanRect.top - mirrorRect.top) - scrollTop - 44;
        let left = taRect.left + (spanRect.left - mirrorRect.left) - scrollLeft;
        const TOOLBAR_W = 230;
        if (left < 4) left = 4;
        if (left + TOOLBAR_W > window.innerWidth - 4) left = window.innerWidth - TOOLBAR_W - 4;
        if (top < 4) top = taRect.top + (spanRect.bottom - mirrorRect.top) - scrollTop + 6;
        setToolbarCoords({ top, left });
      });
    } else {
      setFormatSel(null);
      setToolbarCoords(null);
    }
  };

  const clearSelection = () => {
    setFormatSel(null);
    setToolbarCoords(null);
  };

  return { formatSel, toolbarCoords, mirrorRef, applyFormat, handleSelect, clearSelection };
}
