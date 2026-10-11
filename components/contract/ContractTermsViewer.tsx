"use client";

import { useMemo, useState } from "react";

export interface ContractTermsViewerProps {
  content: string | null | undefined;
  className?: string;
  maxHeight?: string; // e.g. "max-h-[550px]" or "none"
  initialExpanded?: boolean;
  showDeclaration?: boolean;
}

interface ParsedClause {
  type: "clause";
  number: string;
  title: string;
  items: string[];
}

interface ParsedSection {
  type: "notice" | "declaration";
  title: string;
  items: string[];
}

interface ParsedContract {
  title: string;
  notice: ParsedSection | null;
  clauses: ParsedClause[];
  declaration: ParsedSection | null;
  other: string[];
  isStructured: boolean;
}

function parseContractContent(raw: string | null | undefined): ParsedContract {
  if (!raw || !String(raw).trim()) {
    return {
      title: "Hostel Accommodation Rules & Resident Agreement",
      notice: null,
      clauses: [],
      declaration: null,
      other: [],
      isStructured: false,
    };
  }

  // Normalize line breaks and tabs into spaces first to handle both newline-separated and collapsed texts
  let text = String(raw).replace(/\r\n/g, " ").replace(/\r/g, " ").replace(/\n/g, " ");

  // Require both section markers and bullet markers to be considered structured
  const hasBullets = text.includes("•");
  const hasSectionMarkers = /(?:IMPORTANT\s*—|\b\d{1,2}\.\s+[A-Za-z]|\bResident Declaration\b)/i.test(text);
  const hasStructure = hasBullets && hasSectionMarkers;

  // If no structure markers at all, return raw paragraphs
  if (!hasStructure) {
    const rawLines = String(raw)
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean);
    return {
      title: "Contract Terms & Conditions",
      notice: null,
      clauses: [],
      declaration: null,
      other: rawLines.length ? rawLines : [String(raw).trim()],
      isStructured: false,
    };
  }

  // Insert explicit section anchors
  text = text
    .replace(/(?:^|\s)(⚠?\s*IMPORTANT\s*—[^\n•]+?)(?=\s*[•]|\n|$)/gi, "\n\n### NOTICE: $1\n")
    .replace(/(?:^|\s)(\d{1,2}\.\s+[A-Za-z0-9\s&—\-,/]+?)(?=\s*[•]|\n)/g, "\n\n### CLAUSE $1\n")
    .replace(/(?:^|\s)(Resident Declaration)(?=\s*[•]|\n|$)/gi, "\n\n### DECLARATION: $1\n")
    .replace(/\s*[•\t]+\s*/g, "\n• ");

  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  let title = "HOSTEL ACCOMMODATION RULES & RESIDENT AGREEMENT";
  let notice: ParsedSection | null = null;
  const clauses: ParsedClause[] = [];
  let declaration: ParsedSection | null = null;
  const other: string[] = [];

  let currentSection: { items: string[] } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("### NOTICE:")) {
      const section: ParsedSection = {
        type: "notice",
        title: line.replace(/^### NOTICE:\s*(?:⚠\s*)?/, "").trim(),
        items: [],
      };
      notice = section;
      currentSection = section;
    } else if (line.startsWith("### CLAUSE ")) {
      const rawClause = line.replace(/^### CLAUSE\s*/, "").trim();
      const match = rawClause.match(/^(\d{1,2})\.\s*(.+)$/);
      const clause: ParsedClause = {
        type: "clause",
        number: match ? match[1] : String(clauses.length + 1),
        title: match ? match[2].trim() : rawClause,
        items: [],
      };
      clauses.push(clause);
      currentSection = clause;
    } else if (line.startsWith("### DECLARATION:")) {
      const section: ParsedSection = {
        type: "declaration",
        title: line.replace(/^### DECLARATION:\s*/, "").trim(),
        items: [],
      };
      declaration = section;
      currentSection = section;
    } else if (line.startsWith("• ")) {
      const itemText = line.substring(2).trim();
      if (currentSection) {
        currentSection.items.push(itemText);
      } else {
        other.push(itemText);
      }
    } else {
      if (i === 0 && !line.startsWith("###")) {
        title = line;
      } else if (currentSection) {
        currentSection.items.push(line);
      } else {
        other.push(line);
      }
    }
  }

  return {
    title,
    notice,
    clauses,
    declaration,
    other,
    isStructured: true,
  };
}

export default function ContractTermsViewer({
  content,
  className = "",
  maxHeight = "none",
  initialExpanded = true,
  showDeclaration = true,
}: ContractTermsViewerProps) {
  const [search, setSearch] = useState("");
  const [allExpanded, setAllExpanded] = useState(initialExpanded);
  const [expandedClauses, setExpandedClauses] = useState<Record<string, boolean>>({});

  const parsed = useMemo(() => parseContractContent(content), [content]);

  const toggleClause = (clauseNum: string) => {
    setExpandedClauses((prev) => {
      const current = prev[clauseNum] ?? allExpanded;
      return { ...prev, [clauseNum]: !current };
    });
  };

  const handleToggleAll = () => {
    const nextState = !allExpanded;
    setAllExpanded(nextState);
    const updated: Record<string, boolean> = {};
    for (const c of parsed.clauses) {
      updated[c.number] = nextState;
    }
    setExpandedClauses(updated);
  };

  const query = search.trim().toLowerCase();

  const filteredClauses = useMemo(() => {
    if (!query) return parsed.clauses;
    return parsed.clauses.filter((c) => {
      const inTitle = c.title.toLowerCase().includes(query);
      const inItems = c.items.some((item) => item.toLowerCase().includes(query));
      return inTitle || inItems;
    });
  }, [parsed.clauses, query]);

  const isNoticeMatched = useMemo(() => {
    if (!query || !parsed.notice) return true;
    return (
      parsed.notice.title.toLowerCase().includes(query) ||
      parsed.notice.items.some((item) => item.toLowerCase().includes(query))
    );
  }, [parsed.notice, query]);

  const isDeclarationMatched = useMemo(() => {
    if (!query || !parsed.declaration) return true;
    return (
      parsed.declaration.title.toLowerCase().includes(query) ||
      parsed.declaration.items.some((item) => item.toLowerCase().includes(query))
    );
  }, [parsed.declaration, query]);

  if (!content || !content.trim()) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-500">
        No contract terms available.
      </div>
    );
  }

  // Fallback for non-structured terms
  if (!parsed.isStructured) {
    return (
      <div className={`space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-xs ${className}`}>
        <h3 className="text-base font-bold text-slate-900">{parsed.title}</h3>
        <div className="space-y-3 text-sm leading-relaxed text-slate-700">
          {parsed.other.map((paragraph, index) => (
            <p key={index} className="whitespace-pre-wrap">
              {paragraph}
            </p>
          ))}
        </div>
      </div>
    );
  }

  const containerScrollStyle = maxHeight !== "none" ? `${maxHeight} overflow-y-auto` : "";

  return (
    <div
      className={`relative flex flex-col rounded-3xl border border-slate-200/90 bg-slate-50/50 shadow-xs ${className}`}
    >
      {/* Header Bar */}
      <div className="border-b border-slate-200/80 bg-white px-5 py-4 sm:px-6 rounded-t-3xl">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-md bg-indigo-50 px-2 py-0.5 text-xs font-semibold text-indigo-700 border border-indigo-100">
                <svg className="h-3.5 w-3.5 text-indigo-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                Official Agreement
              </span>
              <span className="text-xs text-slate-400">•</span>
              <span className="text-xs font-medium text-slate-500">
                {parsed.clauses.length} Clauses
              </span>
              {parsed.notice && (
                <>
                  <span className="text-xs text-slate-400">•</span>
                  <span className="text-xs font-medium text-amber-700">
                    30-Day Notice Mandatory
                  </span>
                </>
              )}
            </div>
            <h3 className="text-base font-bold text-slate-900 sm:text-lg">
              {parsed.title}
            </h3>
          </div>

          {/* Search & Collapse Controls */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[200px] flex-1 sm:w-64">
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search rules, timings, fines..."
                className="w-full rounded-xl border border-slate-200 bg-slate-50/70 pl-8 pr-8 py-1.5 text-xs text-slate-800 placeholder-slate-400 focus:border-indigo-500 focus:bg-white focus:outline-none"
              />
              <svg
                className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  className="absolute right-2.5 top-2 text-xs font-bold text-slate-400 hover:text-slate-600"
                  aria-label="Clear search"
                >
                  ✕
                </button>
              )}
            </div>

            <button
              type="button"
              onClick={handleToggleAll}
              className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 hover:text-slate-900 transition-colors"
            >
              {allExpanded ? "Collapse All" : "Expand All"}
            </button>
          </div>
        </div>
      </div>

      {/* Main Content Area */}
      <div className={`p-4 sm:p-6 space-y-4 ${containerScrollStyle}`}>
        {/* Important Notice Warning Banner */}
        {parsed.notice && isNoticeMatched && (
          <div className="rounded-2xl border-2 border-amber-300 bg-linear-to-r from-amber-50 to-orange-50/40 p-4 sm:p-5 shadow-xs">
            <div className="flex items-start gap-3">
              <div className="rounded-xl bg-amber-500/10 p-2 text-amber-600 shrink-0 mt-0.5">
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              </div>
              <div className="space-y-2 flex-1">
                <div className="flex items-center gap-2">
                  <span className="rounded-full bg-amber-200/70 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider text-amber-900">
                    Mandatory Policy
                  </span>
                  <h4 className="text-sm font-bold text-amber-950 sm:text-base">
                    {parsed.notice.title}
                  </h4>
                </div>
                <ul className="space-y-2 pt-1">
                  {parsed.notice.items.map((item, idx) => (
                    <li key={idx} className="flex items-start gap-2.5 text-xs sm:text-sm text-amber-900/90 leading-relaxed">
                      <span className="h-1.5 w-1.5 rounded-full bg-amber-600 mt-2 shrink-0" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        )}

        {/* Numbered Clauses */}
        {filteredClauses.length > 0 ? (
          <div className="space-y-3">
            {filteredClauses.map((clause) => {
              const isExpanded = expandedClauses[clause.number] ?? allExpanded;
              const hasPenalty =
                clause.title.toLowerCase().includes("fine") ||
                clause.title.toLowerCase().includes("pkr") ||
                clause.title.toLowerCase().includes("prohibited");

              return (
                <div
                  key={clause.number}
                  className="rounded-2xl border border-slate-200/90 bg-white transition-all hover:border-slate-300 shadow-2xs overflow-hidden"
                >
                  <button
                    type="button"
                    onClick={() => toggleClause(clause.number)}
                    className="flex w-full items-center justify-between gap-3 px-4 py-3 sm:px-5 sm:py-3.5 text-left transition-colors hover:bg-slate-50/70"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-50 text-xs font-bold text-indigo-700 border border-indigo-100 shrink-0">
                        {clause.number.padStart(2, "0")}
                      </span>
                      <span className="truncate text-sm font-bold text-slate-800 sm:text-base">
                        {clause.title}
                      </span>
                      {hasPenalty && (
                        <span className="hidden sm:inline-flex rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-semibold text-rose-700 border border-rose-200 shrink-0">
                          Penalty Clause
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-xs text-slate-400 hidden sm:inline">
                        {clause.items.length} {clause.items.length === 1 ? "rule" : "rules"}
                      </span>
                      <svg
                        className={`h-4 w-4 text-slate-400 transition-transform duration-200 ${
                          isExpanded ? "rotate-180" : ""
                        }`}
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </div>
                  </button>

                  {isExpanded && (
                    <div className="border-t border-slate-100 bg-slate-50/30 px-4 py-3.5 sm:px-5 sm:py-4">
                      <ul className="space-y-2.5">
                        {clause.items.map((item, idx) => (
                          <li
                            key={idx}
                            className="flex items-start gap-3 text-xs sm:text-sm text-slate-700 leading-relaxed"
                          >
                            <span className="h-1.5 w-1.5 rounded-full bg-indigo-500 mt-2 shrink-0" />
                            <span className="flex-1">{item}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-8 text-center">
            <p className="text-sm font-medium text-slate-600">
              No clauses matched &quot;{search}&quot;.
            </p>
            <button
              type="button"
              onClick={() => setSearch("")}
              className="mt-2 text-xs font-semibold text-indigo-600 hover:underline"
            >
              Clear search filter
            </button>
          </div>
        )}

        {/* Resident Declaration Card */}
        {showDeclaration && parsed.declaration && isDeclarationMatched && (
          <div className="rounded-2xl border-2 border-indigo-200 bg-linear-to-r from-indigo-50/70 to-slate-50 p-4 sm:p-5 shadow-xs">
            <div className="flex items-start gap-3">
              <div className="rounded-xl bg-indigo-600/10 p-2 text-indigo-600 shrink-0 mt-0.5">
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                </svg>
              </div>
              <div className="space-y-2.5 flex-1">
                <div>
                  <h4 className="text-sm font-bold text-slate-900 sm:text-base">
                    {parsed.declaration.title}
                  </h4>
                  <p className="text-xs text-slate-500 mt-0.5">
                    By submitting your signature below, you affirm and accept all of the following:
                  </p>
                </div>
                <ul className="space-y-2 pt-1">
                  {parsed.declaration.items.map((item, idx) => (
                    <li
                      key={idx}
                      className="flex items-start gap-2.5 text-xs sm:text-sm text-slate-800 leading-relaxed"
                    >
                      <svg
                        className="h-4 w-4 text-emerald-600 mt-0.5 shrink-0"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                      </svg>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        )}

        {/* Other text fallback if present */}
        {parsed.other.length > 0 && (
          <div className="rounded-2xl border border-slate-200 bg-white p-4 space-y-2">
            <h5 className="text-xs font-bold uppercase tracking-wider text-slate-500">
              Additional Terms
            </h5>
            <div className="space-y-1.5 text-xs sm:text-sm text-slate-700">
              {parsed.other.map((item, idx) => (
                <p key={idx}>{item}</p>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
