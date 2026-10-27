import { useId, useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { ACCESS_VALUES, END_TAG_KEYS, KNOWN_TAG_KEYS, LINK_VALUES, MAX_TAGS, TAG_SUGGESTIONS, formatTag, normalizeTag, tagEndError, type Tag, type TagEnd } from "@shared/tags";

/**
 * Network tags as chips (designs/2026-10-22-network-tags-design.md "Console
 * UI"): type `key:value` and press Enter. Every tag goes through
 * shared/tags.ts's normalizeTag — the same check the server runs — so an
 * error shows here, inline, before a save could 400. One value per key: a
 * second `isp:` replaces the first. Used by the eval flow form, the Agents
 * page and as the metrics filter. With `end`, only that end's known keys are
 * offered and accepted (the server's parseTags `end` rule) — never the
 * system-only `access`/`sim`, which Vox alone sets; without it (the metrics
 * filter) every key is, so results can be filtered by them.
 */
export interface TagInputProps {
  value: Tag[];
  onChange: (tags: Tag[]) => void;
  /** Which end the tags describe: "flow" (line + custom keys) or "agent" (isp/link + custom keys). Unset = any key (filters). */
  end?: TagEnd;
  /** Keys suggested first (e.g. `line` on a phone flow). */
  preferredKeys?: string[];
  placeholder?: string;
  disabled?: boolean;
  maxTags?: number;
  className?: string;
  /** Prefix for data-testid attributes. */
  testId?: string;
  "aria-label"?: string;
}

/** Suggested values for a known key; `link` and `access` are closed sets. */
function valuesFor(key: string): readonly string[] {
  if (key === "link") return LINK_VALUES;
  if (key === "access") return ACCESS_VALUES;
  return (TAG_SUGGESTIONS as Record<string, string[]>)[key] ?? [];
}

export function TagInput({
  value,
  onChange,
  end,
  preferredKeys = [],
  placeholder = end === "agent" ? "key:value, e.g. isp:starlink" : "key:value, e.g. line:twilio",
  disabled,
  maxTags = MAX_TAGS,
  className,
  testId = "tag-input",
  "aria-label": ariaLabel,
}: TagInputProps) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const errorId = useId();
  const full = value.length >= maxTags;

  const add = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    if (!trimmed.includes(":")) {
      setError(`Write a tag as key:value, for example line:twilio.`);
      return;
    }
    const t = normalizeTag(trimmed);
    if ("error" in t) {
      setError(`${t.error}.`);
      return;
    }
    const endError = end ? tagEndError(t.key, end) : undefined;
    if (endError) {
      setError(`${endError}.`);
      return;
    }
    const replacing = value.some((v) => v.key === t.key);
    if (!replacing && full) {
      setError(`At most ${maxTags} tags. Remove one to add another.`);
      return;
    }
    onChange(replacing ? value.map((v) => (v.key === t.key ? t : v)) : [...value, t]);
    setText("");
    setError(null);
  };

  const remove = (key: string) => {
    onChange(value.filter((v) => v.key !== key));
    setError(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      add(text);
    } else if (e.key === "Backspace" && text === "" && value.length > 0) {
      remove(value[value.length - 1].key);
    }
  };

  // Suggestions: before a colon, the known keys (preferred first) matching
  // what's typed; after a known key's colon, its values.
  const suggestions = (() => {
    const idx = text.indexOf(":");
    if (idx < 0) {
      const prefix = text.trim().toLowerCase();
      const known = end ? END_TAG_KEYS[end] : KNOWN_TAG_KEYS;
      const keys = Array.from(new Set([...preferredKeys, ...known])).filter((k) => known.includes(k));
      return keys
        .filter((k) => k.startsWith(prefix) && !value.some((v) => v.key === k))
        .map((k) => ({ label: `${k}:`, apply: () => { setText(`${k}:`); setError(null); } }));
    }
    const key = text.slice(0, idx).trim().toLowerCase();
    if (end && tagEndError(key, end)) return [];
    const prefix = text.slice(idx + 1).trim().toLowerCase();
    return valuesFor(key)
      .filter((v) => v.startsWith(prefix))
      .map((v) => ({ label: `${key}:${v}`, apply: () => add(`${key}:${v}`) }));
  })();

  return (
    <div className={cn("space-y-1.5", className)} data-testid={testId}>
      <div
        className={cn(
          "flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border border-input bg-transparent px-2 py-1 text-sm shadow-xs",
          focused && "ring-1 ring-ring",
          error && "border-destructive",
          disabled && "opacity-50",
        )}
      >
        {value.map((t) => (
          <Badge key={t.key} variant="secondary" className="gap-1 font-mono font-normal" data-testid={`${testId}-chip-${t.key}`}>
            {formatTag(t)}
            {!disabled && (
              <button
                type="button"
                className="rounded-sm opacity-60 hover:opacity-100"
                onClick={() => remove(t.key)}
                aria-label={`Remove ${formatTag(t)}`}
                data-testid={`${testId}-remove-${t.key}`}
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </Badge>
        ))}
        <Input
          value={text}
          disabled={disabled}
          onChange={(e) => { setText(e.target.value); setError(null); }}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={value.length === 0 ? placeholder : full ? "" : "Add a tag"}
          aria-label={ariaLabel ?? "Add a tag"}
          aria-invalid={!!error}
          aria-describedby={error ? errorId : undefined}
          className="h-7 min-w-[5rem] flex-1 border-0 px-1 py-0 shadow-none focus-visible:ring-0"
          data-testid={`${testId}-field`}
        />
      </div>
      {error ? (
        <p id={errorId} className="text-xs text-destructive" data-testid={`${testId}-error`}>{error}</p>
      ) : focused && suggestions.length > 0 && !full ? (
        <div className="flex flex-wrap gap-1" data-testid={`${testId}-suggestions`}>
          {suggestions.map((s) => (
            <button
              key={s.label}
              type="button"
              // mousedown, not click: keep the focus in the field.
              onMouseDown={(e) => { e.preventDefault(); s.apply(); }}
              className="rounded border px-1.5 py-0.5 font-mono text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {s.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
