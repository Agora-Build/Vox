import { useState, useEffect, useCallback, useRef } from "react";

// ============================================================
// HSL <-> Hex conversion utilities
// ============================================================

function hslToHex(hslStr: string): string {
  const parts = hslStr.trim().split(/\s+/);
  if (parts.length < 3) return "#000000";
  const h = parseFloat(parts[0]) / 360;
  const s = parseFloat(parts[1]) / 100;
  const l = parseFloat(parts[2]) / 100;

  let r: number, g: number, b: number;
  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  const toHex = (x: number) =>
    Math.round(x * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function hexToHsl(hex: string): string {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) return "0 0% 0%";
  const r = parseInt(result[1], 16) / 255;
  const g = parseInt(result[2], 16) / 255;
  const b = parseInt(result[3], 16) / 255;

  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  let h = 0,
    s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        break;
      case g:
        h = ((b - r) / d + 2) / 6;
        break;
      case b:
        h = ((r - g) / d + 4) / 6;
        break;
    }
  }
  return `${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

// ============================================================
// CSS Variable definitions grouped by category
// ============================================================

interface VarDef {
  name: string;
  isColor: boolean;
}

interface VarGroup {
  label: string;
  vars: VarDef[];
}

const VAR_GROUPS: VarGroup[] = [
  {
    label: "Colors",
    vars: [
      { name: "--background", isColor: true },
      { name: "--foreground", isColor: true },
      { name: "--primary", isColor: true },
      { name: "--primary-foreground", isColor: true },
      { name: "--secondary", isColor: true },
      { name: "--secondary-foreground", isColor: true },
      { name: "--muted", isColor: true },
      { name: "--muted-foreground", isColor: true },
      { name: "--accent", isColor: true },
      { name: "--accent-foreground", isColor: true },
      { name: "--destructive", isColor: true },
      { name: "--destructive-foreground", isColor: true },
    ],
  },
  {
    label: "UI",
    vars: [
      { name: "--border", isColor: true },
      { name: "--input", isColor: true },
      { name: "--ring", isColor: true },
      { name: "--card", isColor: true },
      { name: "--card-foreground", isColor: true },
      { name: "--popover", isColor: true },
      { name: "--popover-foreground", isColor: true },
    ],
  },
  {
    label: "Sidebar",
    vars: [
      { name: "--sidebar", isColor: true },
      { name: "--sidebar-foreground", isColor: true },
      { name: "--sidebar-primary", isColor: true },
      { name: "--sidebar-primary-foreground", isColor: true },
      { name: "--sidebar-accent", isColor: true },
      { name: "--sidebar-accent-foreground", isColor: true },
      { name: "--sidebar-border", isColor: true },
      { name: "--sidebar-ring", isColor: true },
    ],
  },
  {
    label: "Charts",
    vars: [
      { name: "--chart-1", isColor: true },
      { name: "--chart-2", isColor: true },
      { name: "--chart-3", isColor: true },
      { name: "--chart-4", isColor: true },
      { name: "--chart-5", isColor: true },
    ],
  },
  {
    label: "Layout",
    vars: [{ name: "--radius", isColor: false }],
  },
];

// ============================================================
// Content change tracking
// ============================================================

interface ContentChange {
  original: string;
  replacement: string;
  tagName: string;
}

// ============================================================
// Persistence
// ============================================================

const STORAGE_KEY = "vox-dev-style-panel";

function loadOverrides(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveOverrides(overrides: Record<string, string>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
}

function getComputedVar(name: string): string {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
}

// ============================================================
// Inline styles (immune to CSS overrides)
// ============================================================

const S = {
  toggleBtn: {
    position: "fixed" as const,
    bottom: "16px",
    right: "16px",
    zIndex: 99999,
    padding: "8px 16px",
    background: "#2563eb",
    color: "#fff",
    border: "none",
    borderRadius: "6px",
    fontSize: "13px",
    fontFamily: "system-ui, sans-serif",
    cursor: "pointer",
    boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
  },
  panel: {
    position: "fixed" as const,
    top: 0,
    right: 0,
    width: "380px",
    height: "100vh",
    zIndex: 99998,
    background: "#111827",
    color: "#e5e7eb",
    fontFamily: "system-ui, sans-serif",
    fontSize: "13px",
    display: "flex",
    flexDirection: "column" as const,
    borderLeft: "1px solid #374151",
    boxShadow: "-4px 0 16px rgba(0,0,0,0.4)",
  },
  header: {
    padding: "12px 16px",
    borderBottom: "1px solid #374151",
    fontSize: "14px",
    fontWeight: 600,
    lineHeight: "1.4",
  },
  tabs: {
    display: "flex",
    borderBottom: "1px solid #374151",
  },
  tab: (active: boolean) => ({
    flex: 1,
    padding: "8px",
    background: active ? "#1f2937" : "transparent",
    color: active ? "#60a5fa" : "#9ca3af",
    border: "none",
    borderBottom: active ? "2px solid #60a5fa" : "2px solid transparent",
    cursor: "pointer",
    fontSize: "12px",
    fontFamily: "system-ui, sans-serif",
  }),
  body: {
    flex: 1,
    overflow: "auto",
    padding: "12px 16px",
  },
  groupLabel: {
    fontSize: "11px",
    fontWeight: 700,
    textTransform: "uppercase" as const,
    color: "#6b7280",
    margin: "16px 0 6px",
    letterSpacing: "0.05em",
  },
  varRow: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    marginBottom: "6px",
  },
  varLabel: {
    width: "170px",
    fontSize: "12px",
    color: "#d1d5db",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  colorInput: {
    width: "32px",
    height: "24px",
    border: "1px solid #4b5563",
    borderRadius: "3px",
    padding: 0,
    cursor: "pointer",
    background: "transparent",
  },
  textInput: {
    flex: 1,
    padding: "3px 6px",
    background: "#1f2937",
    color: "#e5e7eb",
    border: "1px solid #374151",
    borderRadius: "3px",
    fontSize: "12px",
    fontFamily: "monospace",
  },
  textarea: {
    width: "100%",
    height: "300px",
    background: "#1f2937",
    color: "#e5e7eb",
    border: "1px solid #374151",
    borderRadius: "4px",
    padding: "8px",
    fontSize: "12px",
    fontFamily: "monospace",
    resize: "vertical" as const,
  },
  footer: {
    padding: "10px 16px",
    borderTop: "1px solid #374151",
    display: "flex",
    flexDirection: "column" as const,
    gap: "6px",
  },
  btnRow: {
    display: "flex",
    gap: "6px",
  },
  btn: (variant: "primary" | "success" | "danger" | "neutral") => {
    const colors = {
      primary: { bg: "#2563eb" },
      success: { bg: "#16a34a" },
      danger: { bg: "#dc2626" },
      neutral: { bg: "#374151" },
    };
    return {
      flex: 1,
      padding: "6px 10px",
      background: colors[variant].bg,
      color: "#fff",
      border: "none",
      borderRadius: "4px",
      fontSize: "12px",
      fontFamily: "system-ui, sans-serif",
      cursor: "pointer",
    };
  },
  status: {
    fontSize: "11px",
    color: "#9ca3af",
    textAlign: "center" as const,
    minHeight: "16px",
  },
};

// ============================================================
// Component
// ============================================================

export default function DevStylePanel() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"theme" | "css" | "content">("theme");
  const [overrides, setOverrides] = useState<Record<string, string>>(loadOverrides);
  const [customCSS, setCustomCSS] = useState("");
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);
  const styleRef = useRef<HTMLStyleElement | null>(null);

  // Content tab state
  const [picking, setPicking] = useState(false);
  const [selectedEl, setSelectedEl] = useState<{ el: HTMLElement; text: string; tag: string } | null>(null);
  const [editText, setEditText] = useState("");
  const [contentChanges, setContentChanges] = useState<ContentChange[]>([]);
  const highlightRef = useRef<HTMLElement | null>(null);

  // Apply CSS overrides on mount and when they change
  useEffect(() => {
    for (const [name, value] of Object.entries(overrides)) {
      document.documentElement.style.setProperty(name, value);
    }
    saveOverrides(overrides);
  }, [overrides]);

  // Manage custom CSS style element
  useEffect(() => {
    let el = document.getElementById("dev-style-panel-custom-css") as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement("style");
      el.id = "dev-style-panel-custom-css";
      document.head.appendChild(el);
    }
    styleRef.current = el;
  }, []);

  useEffect(() => {
    if (styleRef.current) {
      styleRef.current.textContent = customCSS;
    }
  }, [customCSS]);

  // Keyboard shortcut: Ctrl+Shift+D
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === "D") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // ---- Element picker for Content tab ----
  useEffect(() => {
    if (!picking) return;

    const clearHighlight = () => {
      if (highlightRef.current) {
        highlightRef.current.style.outline = "";
        highlightRef.current.style.outlineOffset = "";
        highlightRef.current = null;
      }
    };

    const onMouseOver = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("[data-devtool]")) return;
      clearHighlight();
      el.style.outline = "2px solid #60a5fa";
      el.style.outlineOffset = "2px";
      highlightRef.current = el;
    };

    const onClick = (e: MouseEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      const el = e.target as HTMLElement;
      if (el.closest("[data-devtool]")) return;
      clearHighlight();
      const text = el.innerText?.trim() || "";
      setSelectedEl({ el, text, tag: el.tagName.toLowerCase() });
      setEditText(text);
      setPicking(false);
    };

    // Escape cancels pick mode
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        clearHighlight();
        setPicking(false);
      }
    };

    document.addEventListener("mouseover", onMouseOver, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      clearHighlight();
      document.removeEventListener("mouseover", onMouseOver, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [picking]);

  // ---- Handlers ----

  const handleVarChange = useCallback((name: string, value: string) => {
    setOverrides((prev) => ({ ...prev, [name]: value }));
    document.documentElement.style.setProperty(name, value);
  }, []);

  const handleColorPickerChange = useCallback(
    (name: string, hex: string) => {
      handleVarChange(name, hexToHsl(hex));
    },
    [handleVarChange]
  );

  const handleApplyContent = useCallback(() => {
    if (!selectedEl) return;
    const original = selectedEl.text;
    const replacement = editText;
    if (original === replacement) return;

    // Update DOM immediately
    selectedEl.el.innerText = replacement;

    setContentChanges((prev) => [
      ...prev,
      { original, replacement, tagName: selectedEl.tag },
    ]);
    setSelectedEl(null);
    setEditText("");
    setStatus(`Applied: <${selectedEl.tag}> text changed`);
  }, [selectedEl, editText]);

  const handleRemoveChange = useCallback((index: number) => {
    setContentChanges((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleReset = useCallback(() => {
    for (const group of VAR_GROUPS) {
      for (const v of group.vars) {
        document.documentElement.style.removeProperty(v.name);
      }
    }
    setOverrides({});
    setCustomCSS("");
    setContentChanges([]);
    setSelectedEl(null);
    setEditText("");
    setPicking(false);
    if (styleRef.current) {
      styleRef.current.textContent = "";
    }
    localStorage.removeItem(STORAGE_KEY);
    setStatus("Reset");
  }, []);

  const handleSave = useCallback(
    async (commit: boolean) => {
      setSaving(true);
      setStatus(commit ? "Saving & committing..." : "Saving...");

      const hasStyleChanges =
        Object.keys(overrides).length > 0 || (customCSS && customCSS.trim());
      const hasContentChanges = contentChanges.length > 0;

      if (!hasStyleChanges && !hasContentChanges) {
        setStatus("Nothing to save");
        setSaving(false);
        return;
      }

      try {
        const messages: string[] = [];

        // 1. Save CSS changes (without commit — we commit after content if both)
        if (hasStyleChanges) {
          const commitStyles = commit && !hasContentChanges;
          const url = commitStyles
            ? "/api/dev/save-styles?commit=true"
            : "/api/dev/save-styles";
          const resp = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              variables: overrides,
              customCSS: customCSS || undefined,
            }),
          });
          const data = await resp.json();
          if (!resp.ok) throw new Error(data.error || "Failed to save styles");
          messages.push(data.message);
        }

        // 2. Save content changes (commits everything if commit=true)
        if (hasContentChanges) {
          const url = commit
            ? "/api/dev/save-content?commit=true"
            : "/api/dev/save-content";
          const resp = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              replacements: contentChanges,
              alsoStageCSS: commit && hasStyleChanges,
            }),
          });
          const data = await resp.json();
          if (!resp.ok) throw new Error(data.error || "Failed to save content");
          messages.push(data.message);

          // Clear applied content changes after successful save
          setContentChanges([]);
        }

        setStatus(messages.join(" | "));
      } catch (err) {
        setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setSaving(false);
      }
    },
    [overrides, customCSS, contentChanges]
  );

  const getCurrentValue = useCallback(
    (name: string): string => {
      return overrides[name] ?? getComputedVar(name);
    },
    [overrides]
  );

  // ---- Render ----

  if (!open) {
    return (
      <button
        style={S.toggleBtn}
        onClick={() => setOpen(true)}
        data-devtool="toggle"
        aria-label="Open Dev Style Panel"
      >
        Dev Styles
      </button>
    );
  }

  return (
    <div style={S.panel} data-devtool="panel">
      {/* Header */}
      <div style={S.header}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>Dev Style Panel</span>
          <button
            style={{
              background: "none",
              border: "none",
              color: "#9ca3af",
              cursor: "pointer",
              fontSize: "18px",
              fontFamily: "system-ui",
            }}
            onClick={() => setOpen(false)}
            aria-label="Close panel"
          >
            x
          </button>
        </div>
        <div style={{ fontSize: "11px", color: "#6b7280", marginTop: "2px" }}>
          Adjust theme, CSS, or text content — then Save to File or Save &amp; Commit
        </div>
      </div>

      {/* Tabs */}
      <div style={S.tabs}>
        <button
          style={S.tab(tab === "theme")}
          onClick={() => setTab("theme")}
          data-devtool="tab-theme"
        >
          Theme
        </button>
        <button
          style={S.tab(tab === "css")}
          onClick={() => setTab("css")}
          data-devtool="tab-css"
        >
          CSS
        </button>
        <button
          style={S.tab(tab === "content")}
          onClick={() => setTab("content")}
          data-devtool="tab-content"
        >
          Content
        </button>
      </div>

      {/* Body */}
      <div style={S.body}>
        {/* ---- Theme Tab ---- */}
        {tab === "theme" && (
          <>
            {VAR_GROUPS.map((group) => (
              <div key={group.label}>
                <div style={S.groupLabel}>{group.label}</div>
                {group.vars.map((v) => {
                  const val = getCurrentValue(v.name);
                  return (
                    <div style={S.varRow} key={v.name}>
                      <label style={S.varLabel} title={v.name}>
                        {v.name}
                      </label>
                      {v.isColor && (
                        <input
                          type="color"
                          style={S.colorInput}
                          value={(() => {
                            try {
                              return hslToHex(val);
                            } catch {
                              return "#000000";
                            }
                          })()}
                          onChange={(e) => handleColorPickerChange(v.name, e.target.value)}
                          data-devtool={`color-${v.name}`}
                          aria-label={`${v.name} color picker`}
                        />
                      )}
                      <input
                        type="text"
                        style={S.textInput}
                        value={overrides[v.name] ?? ""}
                        placeholder={getComputedVar(v.name)}
                        onChange={(e) => handleVarChange(v.name, e.target.value)}
                        data-devtool={`var-${v.name}`}
                        aria-label={`${v.name} value`}
                      />
                    </div>
                  );
                })}
              </div>
            ))}
          </>
        )}

        {/* ---- CSS Tab ---- */}
        {tab === "css" && (
          <>
            <div style={{ marginBottom: "8px", color: "#9ca3af" }}>
              Write arbitrary CSS below. Applied instantly.
            </div>
            <textarea
              style={S.textarea}
              value={customCSS}
              onChange={(e) => setCustomCSS(e.target.value)}
              placeholder={`.example {\n  font-size: 20px;\n}`}
              data-devtool="css-editor"
              aria-label="Custom CSS editor"
            />
          </>
        )}

        {/* ---- Content Tab ---- */}
        {tab === "content" && (
          <>
            <div style={{ marginBottom: "10px", color: "#9ca3af", lineHeight: "1.5" }}>
              Pick a text element on the page, edit its content, then Apply. Changes are
              saved to .tsx source files when you click Save to File.
            </div>

            {/* Pick Element button */}
            <button
              style={{
                ...S.btn(picking ? "danger" : "neutral"),
                flex: "none",
                width: "100%",
                marginBottom: "12px",
                padding: "8px",
              }}
              onClick={() => {
                setPicking(!picking);
                if (!picking) {
                  setSelectedEl(null);
                  setEditText("");
                }
              }}
              data-devtool="pick-element"
            >
              {picking ? "Cancel Picking (Esc)" : "Pick Element"}
            </button>

            {picking && (
              <div
                style={{
                  padding: "8px",
                  background: "#1e3a5f",
                  borderRadius: "4px",
                  marginBottom: "12px",
                  color: "#93c5fd",
                  fontSize: "12px",
                }}
              >
                Click any text element on the page to select it...
              </div>
            )}

            {/* Selected element editor */}
            {selectedEl && !picking && (
              <div
                style={{
                  border: "1px solid #374151",
                  borderRadius: "4px",
                  padding: "10px",
                  marginBottom: "12px",
                  background: "#1f2937",
                }}
              >
                <div style={{ fontSize: "11px", color: "#6b7280", marginBottom: "6px" }}>
                  Selected: &lt;{selectedEl.tag}&gt;
                </div>

                <div style={{ fontSize: "11px", color: "#6b7280", marginBottom: "2px" }}>
                  Original text:
                </div>
                <div
                  style={{
                    padding: "6px",
                    background: "#111827",
                    borderRadius: "3px",
                    fontSize: "12px",
                    color: "#9ca3af",
                    marginBottom: "8px",
                    maxHeight: "60px",
                    overflow: "auto",
                    fontFamily: "monospace",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                  data-devtool="original-text"
                >
                  {selectedEl.text}
                </div>

                <div style={{ fontSize: "11px", color: "#6b7280", marginBottom: "2px" }}>
                  New text:
                </div>
                <textarea
                  style={{
                    ...S.textarea,
                    height: "80px",
                    marginBottom: "8px",
                  }}
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  data-devtool="new-text"
                  aria-label="New text content"
                />

                <button
                  style={{ ...S.btn("primary"), flex: "none", width: "100%" }}
                  onClick={handleApplyContent}
                  disabled={editText === selectedEl.text}
                  data-devtool="apply-change"
                >
                  Apply Change
                </button>
              </div>
            )}

            {/* Pending changes list */}
            {contentChanges.length > 0 && (
              <>
                <div style={S.groupLabel}>
                  Pending Changes ({contentChanges.length})
                </div>
                {contentChanges.map((change, i) => (
                  <div
                    key={i}
                    style={{
                      border: "1px solid #374151",
                      borderRadius: "4px",
                      padding: "8px",
                      marginBottom: "6px",
                      background: "#1f2937",
                      fontSize: "11px",
                    }}
                    data-devtool={`change-${i}`}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
                      <span style={{ color: "#6b7280" }}>&lt;{change.tagName}&gt;</span>
                      <button
                        style={{
                          background: "none",
                          border: "none",
                          color: "#ef4444",
                          cursor: "pointer",
                          fontSize: "11px",
                          fontFamily: "system-ui",
                          padding: "0 2px",
                        }}
                        onClick={() => handleRemoveChange(i)}
                        aria-label={`Remove change ${i}`}
                        data-devtool={`remove-change-${i}`}
                      >
                        remove
                      </button>
                    </div>
                    <div style={{ color: "#f87171", fontFamily: "monospace", wordBreak: "break-word" }}>
                      - {change.original.length > 80 ? change.original.slice(0, 80) + "..." : change.original}
                    </div>
                    <div style={{ color: "#4ade80", fontFamily: "monospace", wordBreak: "break-word" }}>
                      + {change.replacement.length > 80 ? change.replacement.slice(0, 80) + "..." : change.replacement}
                    </div>
                  </div>
                ))}
              </>
            )}

            {!picking && !selectedEl && contentChanges.length === 0 && (
              <div style={{ color: "#4b5563", textAlign: "center", padding: "24px 0" }}>
                No changes yet. Click "Pick Element" to start.
              </div>
            )}
          </>
        )}
      </div>

      {/* Footer */}
      <div style={S.footer}>
        <div style={S.btnRow}>
          <button
            style={S.btn("primary")}
            onClick={() => handleSave(false)}
            disabled={saving}
            data-devtool="save"
          >
            Save to File
          </button>
          <button
            style={S.btn("success")}
            onClick={() => handleSave(true)}
            disabled={saving}
            data-devtool="save-commit"
          >
            Save &amp; Commit
          </button>
        </div>
        <div style={S.btnRow}>
          <button
            style={S.btn("danger")}
            onClick={handleReset}
            data-devtool="reset"
          >
            Reset All
          </button>
        </div>
        <div style={S.status} data-devtool="status">
          {status}
        </div>
      </div>
    </div>
  );
}
