import { ChangeEvent, useEffect, useMemo, useState } from "react";

type StandardFieldKey =
  | "company"
  | "role"
  | "status"
  | "appliedDate"
  | "location"
  | "nextAction"
  | "nextActionDue"
  | "notes"
  | "source"
  | "link"
  | "salary"
  | "lastUpdated";

type DateFieldKey = "appliedDate" | "nextActionDue" | "lastUpdated";
type FieldKey = StandardFieldKey | `custom:${string}`;

type DateResolution =
  | { kind: "year"; year: string }
  | { kind: "nearestPast" }
  | { kind: "sequence"; startYear: string | null };

type JobRecord = {
  id: string;
  company: string;
  role: string;
  status: string;
  appliedDate: string;
  location: string;
  nextAction: string;
  nextActionDue: string;
  notes: string;
  source: string;
  link: string;
  salary: string;
  lastUpdated: string;
  customValues: Record<string, string>;
};

type CustomColumn = {
  id: string;
  label: string;
  helpText: string;
};

type PersistedDashboard = {
  records: JobRecord[];
  customColumns: CustomColumn[];
  hiddenColumns: string[];
  statusOptions: string[];
};

type ImportSummary = {
  importedCount: number;
  mappedFields: string[];
  unmatchedColumns: string[];
  ambiguousDateCount: number;
};

type RawRow = Record<string, unknown>;

type PendingImport = {
  rows: RawRow[];
  sourceLabel: string;
  headers: string[];
  fieldMap: Record<string, string>;
  dateResolutions: Partial<Record<DateFieldKey, DateResolution>>;
};

type AmbiguousDatePreview = {
  field: DateFieldKey;
  header: string;
  count: number;
  samples: string[];
  supportsSequence: boolean;
  wrapCount: number;
};

type ImportFieldDefinition = {
  key: FieldKey;
  label: string;
  helpText: string;
  matchers: string[];
  isDate?: boolean;
  isCustom?: boolean;
};

const STORAGE_KEY = "job-dashboard-records";
const DEFAULT_STATUS_OPTIONS = ["Applied", "Interviewing", "Take-home", "Offer", "Rejected"];

const STANDARD_FIELDS: Array<{
  key: StandardFieldKey;
  label: string;
  helpText: string;
  matchers: string[];
  isDate?: boolean;
}> = [
  {
    key: "company",
    label: "Company",
    helpText: "The employer or organization you applied to.",
    matchers: ["company", "employer", "organization", "org"],
  },
  {
    key: "role",
    label: "Role",
    helpText: "The job title or position name.",
    matchers: ["role", "title", "position", "job", "job title"],
  },
  {
    key: "status",
    label: "Status",
    helpText: "Your current pipeline state, like Applied, Interviewing, Offer, or Rejected.",
    matchers: ["status", "application status", "state", "outcome", "stage", "pipeline", "process"],
  },
  {
    key: "appliedDate",
    label: "Applied date",
    helpText: "When you applied or first entered the opportunity.",
    matchers: ["applied", "application date", "date applied", "submitted"],
    isDate: true,
  },
  {
    key: "location",
    label: "Location",
    helpText: "City, office, or remote/hybrid setup.",
    matchers: ["location", "city", "remote", "hybrid"],
  },
  {
    key: "nextAction",
    label: "To do task",
    helpText: "The next action you need to take, like sending availability or finishing a take-home.",
    matchers: ["todo", "to do", "next step", "action item", "follow up", "task"],
  },
  {
    key: "nextActionDue",
    label: "To do date",
    helpText: "When that next action is due.",
    matchers: ["due", "deadline", "next action due", "follow up by"],
    isDate: true,
  },
  {
    key: "notes",
    label: "Notes",
    helpText: "Freeform details, context, or reminders.",
    matchers: ["notes", "comment", "details", "summary"],
  },
  {
    key: "source",
    label: "Source",
    helpText: "Where the job came from, like LinkedIn, referral, or company site.",
    matchers: ["source", "referral", "board", "where found"],
  },
  {
    key: "link",
    label: "Job link",
    helpText: "A URL to the job posting or application.",
    matchers: ["link", "url", "posting", "job link"],
  },
  {
    key: "salary",
    label: "Salary",
    helpText: "Compensation or pay range information.",
    matchers: ["salary", "comp", "compensation", "pay"],
  },
  {
    key: "lastUpdated",
    label: "Last updated",
    helpText: "The last time this application was updated in your source sheet.",
    matchers: ["updated", "last touch", "last update", "recent touch"],
    isDate: true,
  },
];

const TABLE_CUSTOM_COLUMN_LIMIT = 4;

function App() {
  const initialState = useMemo(() => loadInitialDashboard(), []);
  const [records, setRecords] = useState<JobRecord[]>(initialState.records);
  const [customColumns, setCustomColumns] = useState<CustomColumn[]>(initialState.customColumns);
  const [hiddenColumns, setHiddenColumns] = useState<string[]>(initialState.hiddenColumns);
  const [statusOptions, setStatusOptions] = useState<string[]>(initialState.statusOptions);
  const [googleSheetUrl, setGoogleSheetUrl] = useState("");
  const [importMessage, setImportMessage] = useState<string>("");
  const [isFetchingSheet, setIsFetchingSheet] = useState(false);
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null);
  const [editingRowId, setEditingRowId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState<JobRecord | null>(null);
  const [isColumnModalOpen, setIsColumnModalOpen] = useState(false);
  const [newCustomColumnName, setNewCustomColumnName] = useState("");
  const [newCustomColumnHelpText, setNewCustomColumnHelpText] = useState("");
  const [isAddingStatus, setIsAddingStatus] = useState(false);
  const [newStatusDraft, setNewStatusDraft] = useState("");

  useEffect(() => {
    const payload: PersistedDashboard = {
      records,
      customColumns,
      hiddenColumns,
      statusOptions,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  }, [records, customColumns, hiddenColumns, statusOptions]);

  const importFields = useMemo(
    () => buildImportFields(customColumns),
    [customColumns],
  );
  const visibleCustomColumns = useMemo(
    () =>
      customColumns
        .filter((column) => !hiddenColumns.includes(toCustomFieldKey(column.id)))
        .slice(0, TABLE_CUSTOM_COLUMN_LIMIT),
    [customColumns, hiddenColumns],
  );
  const configurableStandardFields = useMemo(
    () =>
      STANDARD_FIELDS.filter((field) =>
        ["company", "role", "status", "appliedDate", "nextAction", "notes"].includes(field.key),
      ),
    [],
  );

  const stats = useMemo(() => computeStats(records), [records]);
  const activeInterviews = useMemo(
    () => records.filter((record) => isActiveProcess(record.status)),
    [records],
  );
  const todoItems = useMemo(
    () => records.filter((record) => Boolean(record.nextAction.trim())),
    [records],
  );

  async function handleGoogleSheetImport() {
    const exportUrl = toGoogleSheetCsvUrl(googleSheetUrl);
    if (!exportUrl) {
      setImportMessage("Paste a valid Google Sheets link or published CSV link.");
      return;
    }

    setIsFetchingSheet(true);
    setImportMessage("");

    try {
      const Papa = (await import("papaparse")).default;
      const response = await fetch(exportUrl);
      if (!response.ok) {
        throw new Error(`Sheet fetch failed with ${response.status}`);
      }

      const csvText = await response.text();
      const parseResult = Papa.parse<RawRow>(csvText, {
        header: true,
        skipEmptyLines: true,
      });

      prepareImportedRows(parseResult.data, "Google Sheets");
    } catch (error) {
      setImportMessage(
        error instanceof Error
          ? error.message
          : "Could not import this Google Sheet. If the sheet is private, export it first.",
      );
    } finally {
      setIsFetchingSheet(false);
    }
  }

  function handleFileImport(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    const lowerName = file.name.toLowerCase();
    if (lowerName.endsWith(".csv")) {
      void import("papaparse").then(({ default: Papa }) => {
        Papa.parse<RawRow>(file, {
          header: true,
          skipEmptyLines: true,
          complete: (result) => prepareImportedRows(result.data, file.name),
          error: (error) => setImportMessage(error.message),
        });
      });
    } else {
      const reader = new FileReader();
      reader.onload = async (loadEvent) => {
        const buffer = loadEvent.target?.result;
        if (!(buffer instanceof ArrayBuffer)) {
          setImportMessage("Could not read that spreadsheet.");
          return;
        }

        const XLSX = await import("xlsx");
        const workbook = XLSX.read(buffer, { type: "array" });
        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json<RawRow>(firstSheet, { defval: "" });
        prepareImportedRows(rows, file.name);
      };
      reader.readAsArrayBuffer(file);
    }

    event.target.value = "";
  }

  function prepareImportedRows(rows: RawRow[], sourceLabel: string) {
    const headers = Object.keys(rows[0] ?? {}).filter(Boolean);
    if (rows.length === 0 || headers.length === 0) {
      setPendingImport(null);
      setImportMessage("No rows were found in that sheet.");
      return;
    }

    setPendingImport({
      rows,
      sourceLabel,
      headers,
      fieldMap: buildFieldMap(headers, importFields),
      dateResolutions: {},
    });
    setImportMessage(
      `Loaded ${rows.length} rows from ${sourceLabel}. Review the field mapping before importing.`,
    );
  }

  function applyPendingImport() {
    if (!pendingImport) {
      return;
    }

    const result = normalizeImportedRows(
      pendingImport.rows,
      pendingImport.sourceLabel,
      pendingImport.fieldMap,
      pendingImport.dateResolutions,
      customColumns,
    );

    setRecords((current) => mergeRecords(current, result.records));
    setImportMessage(
      `Imported ${result.summary.importedCount} rows. Mapped ${result.summary.mappedFields.join(", ") || "no known fields"}.${
        result.summary.ambiguousDateCount > 0
          ? ` Preserved ${result.summary.ambiguousDateCount} unresolved date value${result.summary.ambiguousDateCount === 1 ? "" : "s"} exactly as written.`
          : ""
      }`,
    );
    setPendingImport(null);
    setEditingRowId(null);
    setEditingDraft(null);
  }

  function updatePendingImportField(field: FieldKey, header: string) {
    setPendingImport((current) =>
      current
        ? {
            ...current,
            fieldMap: {
              ...current.fieldMap,
              [field]: header,
            },
          }
        : null,
    );
  }

  function updatePendingDateResolution(field: DateFieldKey, year: string) {
    setPendingImport((current) =>
      current
        ? {
            ...current,
            dateResolutions: {
              ...current.dateResolutions,
              [field]: { kind: "year", year },
            },
          }
        : null,
    );
  }

  function updatePendingDateResolutionMode(
    field: DateFieldKey,
    mode: "keep" | "nearestPast" | "year" | "sequence",
  ) {
    setPendingImport((current) => {
      if (!current) {
        return null;
      }

      const nextResolutions = { ...current.dateResolutions };
      if (mode === "keep") {
        delete nextResolutions[field];
      } else if (mode === "nearestPast") {
        nextResolutions[field] = { kind: "nearestPast" };
      } else if (mode === "sequence") {
        nextResolutions[field] = {
          kind: "sequence",
          startYear:
            current.dateResolutions[field]?.kind === "sequence"
              ? current.dateResolutions[field].startYear
              : null,
        };
      } else {
        nextResolutions[field] = {
          kind: "year",
          year: getResolutionYear(current.dateResolutions[field]) ?? String(new Date().getFullYear()),
        };
      }

      return {
        ...current,
        dateResolutions: nextResolutions,
      };
    });
  }

  function updatePendingSequenceStartYear(field: DateFieldKey, startYear: string) {
    setPendingImport((current) =>
      current
        ? {
            ...current,
            dateResolutions: {
              ...current.dateResolutions,
              [field]: { kind: "sequence", startYear },
            },
          }
        : null,
    );
  }

  function applyBulkDateResolution(strategy: "current" | "nearestPast") {
    setPendingImport((current) => {
      if (!current) {
        return null;
      }

      const previews = inspectAmbiguousDates(
        current.rows,
        current.fieldMap,
        {},
      );
      const nextResolutions: Partial<Record<DateFieldKey, DateResolution>> = {
        ...current.dateResolutions,
      };

      previews.forEach((preview) => {
        nextResolutions[preview.field] = resolveYearForStrategy(strategy);
      });

      return {
        ...current,
        dateResolutions: nextResolutions,
      };
    });
  }

  function applyBulkSequenceResolution() {
    setPendingImport((current) => {
      if (!current) {
        return null;
      }

      const previews = inspectAmbiguousDates(current.rows, current.fieldMap, {});
      const nextResolutions: Partial<Record<DateFieldKey, DateResolution>> = {
        ...current.dateResolutions,
      };

      previews.forEach((preview) => {
        const existingResolution = current.dateResolutions[preview.field];
        if (preview.supportsSequence) {
          nextResolutions[preview.field] = {
            kind: "sequence",
            startYear: existingResolution?.kind === "sequence" ? existingResolution.startYear : null,
          };
        }
      });

      return {
        ...current,
        dateResolutions: nextResolutions,
      };
    });
  }

  function addCustomColumn(columnLabel: string, helpText?: string, mappedHeader?: string) {
    const label = columnLabel.trim();
    if (!label) {
      return;
    }
    const nextColumn: CustomColumn = {
      id: crypto.randomUUID(),
      label,
      helpText: helpText?.trim() || `Custom field for ${label}.`,
    };

    setCustomColumns((current) => [...current, nextColumn]);
    setHiddenColumns((current) => current.filter((column) => column !== toCustomFieldKey(nextColumn.id)));
    setPendingImport((current) => {
      if (!current) {
        return current;
      }

      const key = toCustomFieldKey(nextColumn.id);
      const guessedHeader = mappedHeader ?? guessHeaderForCustomField(current.headers, nextColumn);
      return {
        ...current,
        fieldMap: {
          ...current.fieldMap,
          [key]: guessedHeader,
        },
      };
    });
  }

  function addCustomColumnFromModal() {
    addCustomColumn(newCustomColumnName, newCustomColumnHelpText);
    setNewCustomColumnName("");
    setNewCustomColumnHelpText("");
  }

  function removeCustomColumn(columnId: string) {
    setCustomColumns((current) => current.filter((column) => column.id !== columnId));
    setHiddenColumns((current) => current.filter((column) => column !== toCustomFieldKey(columnId)));
    setRecords((current) =>
      current.map((record) => {
        const nextCustomValues = { ...record.customValues };
        delete nextCustomValues[columnId];
        return {
          ...record,
          customValues: nextCustomValues,
        };
      }),
    );
    setPendingImport((current) => {
      if (!current) {
        return null;
      }

      const nextFieldMap = { ...current.fieldMap };
      delete nextFieldMap[toCustomFieldKey(columnId)];
      return {
        ...current,
        fieldMap: nextFieldMap,
      };
    });
    setEditingDraft((current) => {
      if (!current) {
        return null;
      }

      const nextCustomValues = { ...current.customValues };
      delete nextCustomValues[columnId];
      return {
        ...current,
        customValues: nextCustomValues,
      };
    });
  }

  function createCustomColumnFromHeader(header: string) {
    addCustomColumn(header, `Imported from unmatched column "${header}".`, header);
  }

  function toggleColumnVisibility(fieldKey: FieldKey) {
    setHiddenColumns((current) =>
      current.includes(fieldKey)
        ? current.filter((key) => key !== fieldKey)
        : [...current, fieldKey],
    );
  }

  function startEditing(record: JobRecord) {
    setEditingRowId(record.id);
    setEditingDraft({
      ...record,
      customValues: { ...record.customValues },
    });
    setIsAddingStatus(false);
    setNewStatusDraft("");
  }

  function updateEditingDraft(field: StandardFieldKey, value: string) {
    setEditingDraft((current) =>
      current
        ? {
            ...current,
            [field]: value,
          }
        : null,
    );
  }

  function updateEditingCustomValue(columnId: string, value: string) {
    setEditingDraft((current) =>
      current
        ? {
            ...current,
            customValues: {
              ...current.customValues,
              [columnId]: value,
            },
          }
        : null,
    );
  }

  function saveEditingRow() {
    if (!editingRowId || !editingDraft) {
      return;
    }

    setRecords((current) =>
      current.map((record) =>
        record.id === editingRowId
          ? {
              ...editingDraft,
              lastUpdated: todayIso(),
            }
          : record,
      ),
    );
    setEditingRowId(null);
    setEditingDraft(null);
    setIsAddingStatus(false);
    setNewStatusDraft("");
  }

  function cancelEditingRow() {
    setEditingRowId(null);
    setEditingDraft(null);
    setIsAddingStatus(false);
    setNewStatusDraft("");
  }

  function addStatusOption() {
    const nextStatus = newStatusDraft.trim();
    if (!nextStatus) {
      return;
    }

    setStatusOptions((current) =>
      current.includes(nextStatus) ? current : [...current, nextStatus],
    );
    updateEditingDraft("status", nextStatus);
    setNewStatusDraft("");
    setIsAddingStatus(false);
  }

  function addBlankRecord() {
    const newRecord = createBlankRecord(customColumns);
    setRecords((current) => [newRecord, ...current]);
    startEditing(newRecord);
  }

  function clearAllData() {
    const shouldClear = window.confirm(
      "Clear all saved job application data and start over?",
    );
    if (!shouldClear) {
      return;
    }

    localStorage.removeItem(STORAGE_KEY);
    setRecords([]);
    setCustomColumns([]);
    setPendingImport(null);
    setEditingRowId(null);
    setEditingDraft(null);
    setGoogleSheetUrl("");
    setImportMessage("All saved data was cleared. Import a new sheet to start again.");
  }

  const pendingImportPreview = useMemo(
    () => (pendingImport ? pendingImport.rows.slice(0, 3) : []),
    [pendingImport],
  );

  const pendingImportSummary = useMemo(
    () =>
      pendingImport
        ? summarizeFieldMap(pendingImport.headers, pendingImport.fieldMap, importFields)
        : null,
    [importFields, pendingImport],
  );

  const pendingAmbiguousDates = useMemo(
    () =>
      pendingImport
        ? inspectAmbiguousDates(
            pendingImport.rows,
            pendingImport.fieldMap,
            pendingImport.dateResolutions,
          )
        : [],
    [pendingImport],
  );

  const resolutionYears = useMemo(() => buildResolutionYears(), []);

  return (
    <div className="app-shell">
      <div className="background-orb background-orb-left" />
      <div className="background-orb background-orb-right" />

      <header className="hero">
        <div>
          <p className="eyebrow">Job Search Command Center</p>
          <h1>Track interviews, tasks, and momentum in one dashboard.</h1>
          <p className="hero-copy">
            Import a Google Sheet, CSV, or Excel file, let the app guess the right
            columns, then clean up and manage each application in place.
          </p>
        </div>
        <div className="hero-panel">
          <div className="hero-stat">
            <span>Total applications</span>
            <strong>{stats.total}</strong>
          </div>
          <div className="hero-stat">
            <span>Interview rate</span>
            <strong>{stats.interviewRate}%</strong>
          </div>
          <div className="hero-stat">
            <span>Open tasks</span>
            <strong>{stats.openTasks}</strong>
          </div>
        </div>
      </header>

      <main className="content-grid">
        <section className="panel import-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Import</p>
              <h2>Bring in your tracker fast</h2>
            </div>
            <button className="ghost-button" onClick={addBlankRecord}>
              Add manual entry
            </button>
          </div>

          {records.length > 0 || customColumns.length > 0 ? (
            <div className="danger-zone">
              <button className="danger-button" onClick={clearAllData}>
                Clear all data
              </button>
              <span>Wipes the current dashboard and custom columns so you can start over.</span>
            </div>
          ) : null}

          <div className="import-grid">
            <label className="upload-card">
              <span>Excel or CSV</span>
              <strong>Drop in `.xlsx`, `.xls`, or `.csv`</strong>
              <p>Headers can vary. The importer maps common column names automatically.</p>
              <input
                type="file"
                accept=".csv,.xlsx,.xls"
                onChange={handleFileImport}
              />
            </label>

            <div className="upload-card">
              <span>Google Sheets</span>
              <strong>Paste a share or published link</strong>
              <p>
                Works best with public or published sheets. Private sheets should be exported
                first.
              </p>
              <input
                value={googleSheetUrl}
                onChange={(event) => setGoogleSheetUrl(event.target.value)}
                placeholder="https://docs.google.com/spreadsheets/d/..."
              />
              <button
                className="primary-button"
                onClick={handleGoogleSheetImport}
                disabled={isFetchingSheet}
              >
                {isFetchingSheet ? "Importing..." : "Import sheet"}
              </button>
            </div>
          </div>

          <p className="import-message">{importMessage}</p>

          {pendingImport && pendingImportSummary ? (
            <div className="mapping-panel">
              <div className="section-heading mapping-heading">
                <div>
                  <p className="eyebrow">Review Mapping</p>
                  <h2>Match your columns before import</h2>
                </div>
                <div className="mapping-actions">
                  <button className="ghost-button" onClick={() => setPendingImport(null)}>
                    Cancel
                  </button>
                  <button className="primary-button" onClick={applyPendingImport}>
                    Import {pendingImport.rows.length} rows
                  </button>
                </div>
              </div>

              <div className="mapping-summary">
                <div className="mapping-chip">
                  <span>Mapped fields</span>
                  <strong>{pendingImportSummary.mappedFields.length}</strong>
                </div>
                <div className="mapping-chip">
                  <span>Unmatched columns</span>
                  <strong>{pendingImportSummary.unmatchedColumns.length}</strong>
                </div>
                <div className="mapping-chip">
                  <span>Source</span>
                  <strong>{pendingImport.sourceLabel}</strong>
                </div>
                <div className="mapping-chip">
                  <span>Ambiguous dates</span>
                  <strong>{pendingAmbiguousDates.length}</strong>
                </div>
              </div>

              {pendingAmbiguousDates.length > 0 ? (
                <div className="mapping-alert">
                  <h3>Review date values without a year before importing</h3>
                  <p>
                    Choose a bulk default below, then override any individual date column if
                    needed. Leave a value unresolved if you want the app to preserve it exactly as
                    written.
                  </p>
                  <div className="bulk-resolution-actions">
                    <button
                      className="ghost-button bulk-button"
                      onClick={() => applyBulkDateResolution("current")}
                    >
                      Apply current year
                    </button>
                    <button
                      className="ghost-button bulk-button"
                      onClick={() => applyBulkDateResolution("nearestPast")}
                    >
                      Apply nearest past year
                    </button>
                    {pendingAmbiguousDates.some((item) => item.supportsSequence) ? (
                      <button
                        className="ghost-button bulk-button"
                        onClick={applyBulkSequenceResolution}
                      >
                        Start at year and roll forward
                      </button>
                    ) : null}
                  </div>
                  <div className="resolution-list">
                    {pendingAmbiguousDates.map((item) => (
                      <div key={item.field} className="resolution-item">
                        <div>
                          <strong>{labelForStandardField(item.field)}</strong>
                          <span>
                            {item.count} ambiguous value{item.count === 1 ? "" : "s"} in column
                            {` "${item.header}"`}
                          </span>
                          <span>Examples: {item.samples.join(", ")}</span>
                          {item.supportsSequence ? (
                            <span>
                              Detected {item.wrapCount} year wrap{item.wrapCount === 1 ? "" : "s"} in
                              chronological order.
                            </span>
                          ) : null}
                        </div>
                        <div className="resolution-controls">
                          <select
                            value={getResolutionMode(pendingImport.dateResolutions[item.field])}
                            onChange={(event) =>
                              updatePendingDateResolutionMode(
                                item.field,
                                event.target.value as "keep" | "nearestPast" | "year" | "sequence",
                              )
                            }
                          >
                            <option value="keep">Keep as written</option>
                            <option value="nearestPast">Use nearest past year</option>
                            <option value="year">Use one year for all</option>
                            {item.supportsSequence ? (
                              <option value="sequence">Start at year and roll forward</option>
                            ) : null}
                          </select>
                          {getResolutionMode(pendingImport.dateResolutions[item.field]) === "year" ? (
                            <select
                              value={getResolutionYear(pendingImport.dateResolutions[item.field]) ?? ""}
                              onChange={(event) =>
                                updatePendingDateResolution(item.field, event.target.value)
                              }
                            >
                              {resolutionYears.map((year) => (
                                <option key={`${item.field}-single-${year}`} value={year}>
                                  {year}
                                </option>
                              ))}
                            </select>
                          ) : null}
                          {getResolutionMode(pendingImport.dateResolutions[item.field]) === "sequence" ? (
                            <select
                              value={getResolutionYear(pendingImport.dateResolutions[item.field]) ?? ""}
                              onChange={(event) =>
                                updatePendingSequenceStartYear(item.field, event.target.value)
                              }
                            >
                              <option value="">Choose start year</option>
                              {resolutionYears.map((year) => (
                                <option key={`${item.field}-sequence-${year}`} value={year}>
                                  Start at {year}
                                </option>
                              ))}
                            </select>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="mapping-grid">
                {importFields.map((field) => (
                  <label key={field.key} className="mapping-card">
                    <div className="mapping-card-header">
                      <span>{field.label}</span>
                      <span className="info-badge" data-tooltip={field.helpText}>
                        ?
                      </span>
                    </div>
                    <select
                      value={pendingImport.fieldMap[field.key] ?? ""}
                      onChange={(event) => updatePendingImportField(field.key, event.target.value)}
                    >
                      <option value="">Leave unmapped</option>
                      {pendingImport.headers.map((header) => (
                        <option key={`${field.key}-${header}`} value={header}>
                          {header}
                        </option>
                      ))}
                    </select>
                    {field.isCustom ? (
                      <div className="mapping-card-actions">
                        <button
                          className="ghost-button mapping-delete-button"
                          onClick={() => removeCustomColumn(stripCustomPrefix(field.key))}
                        >
                          Delete custom column
                        </button>
                        <button
                          className="ghost-button mapping-delete-button"
                          onClick={() => toggleColumnVisibility(field.key)}
                        >
                          {hiddenColumns.includes(field.key) ? "Show column" : "Hide column"}
                        </button>
                      </div>
                    ) : (
                      <button
                        className="ghost-button mapping-delete-button"
                        onClick={() => toggleColumnVisibility(field.key)}
                      >
                        {hiddenColumns.includes(field.key) ? "Show column" : "Hide column"}
                      </button>
                    )}
                  </label>
                ))}
              </div>

              <div className="mapping-preview-grid">
                <div className="mapping-preview-card">
                  <h3>Unmatched columns</h3>
                  <p className="mapping-preview-note">
                    Click an unmatched column to add a new one.
                  </p>
                  <div className="mapping-tags">
                    {pendingImportSummary.unmatchedColumns.length > 0 ? (
                      pendingImportSummary.unmatchedColumns.map((column) => (
                        <button
                          key={column}
                          className="tag tag-button"
                          onClick={() => createCustomColumnFromHeader(column)}
                        >
                          {column}
                        </button>
                      ))
                    ) : (
                      <span className="tag tag-success">All detected headers are mapped</span>
                    )}
                  </div>
                </div>

                <div className="mapping-preview-card">
                  <h3>Preview rows</h3>
                  <div className="preview-table-scroll">
                    <table className="preview-table">
                      <thead>
                        <tr>
                          {pendingImport.headers.slice(0, 6).map((header) => (
                            <th key={header}>{header}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {pendingImportPreview.map((row, index) => (
                          <tr key={`preview-${index}`}>
                            {pendingImport.headers.slice(0, 6).map((header) => (
                              <td key={`${index}-${header}`}>{readMappedValue(row, header) || "—"}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </section>

        <section className="panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Highlights</p>
              <h2>Where attention is needed now</h2>
            </div>
          </div>

          <div className="highlight-grid">
            <div className="highlight-card">
              <h3>Active interview loops</h3>
              <ul>
                {activeInterviews.slice(0, 5).map((record) => (
                  <li key={record.id}>
                    <strong>{record.company}</strong>
                    <span>{record.status}</span>
                  </li>
                ))}
                {activeInterviews.length === 0 ? (
                  <li>
                    <strong>No active interviews yet</strong>
                    <span>Import data or add a role to start tracking progress.</span>
                  </li>
                ) : null}
              </ul>
            </div>

            <div className="highlight-card">
              <h3>Next actions</h3>
              <ul>
                {todoItems.slice(0, 5).map((record) => (
                  <li key={record.id}>
                    <strong>{record.nextAction}</strong>
                    <span>
                      {record.company}
                      {record.nextActionDue ? ` • due ${record.nextActionDue}` : ""}
                    </span>
                  </li>
                ))}
                {todoItems.length === 0 ? (
                  <li>
                    <strong>No open tasks</strong>
                    <span>Your follow-ups and take-homes will show up here.</span>
                  </li>
                ) : null}
              </ul>
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Pipeline</p>
              <h2>Application overview</h2>
            </div>
          </div>

          <div className="metric-grid">
            {stats.cards.map((card) => (
              <div key={card.label} className="metric-card">
                <span>{card.label}</span>
                <strong>{card.value}</strong>
              </div>
            ))}
          </div>
        </section>

        <section className="panel table-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Applications</p>
              <h2>Edit every record inline</h2>
            </div>
            <button className="ghost-button" onClick={() => setIsColumnModalOpen(true)}>
              Edit columns
            </button>
          </div>

          {records.length === 0 ? (
            <div className="empty-state">
              <p className="eyebrow">Start Here</p>
              <h3>No applications yet</h3>
              <p>
                Import a Google Sheet, CSV, or Excel file to populate your dashboard, or add a
                manual entry to build your tracker from scratch.
              </p>
              <div className="empty-state-actions">
                <button className="primary-button" onClick={addBlankRecord}>
                  Add first application
                </button>
              </div>
            </div>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    {!hiddenColumns.includes("company") ? <th>Company</th> : null}
                    {!hiddenColumns.includes("role") ? <th>Role</th> : null}
                    {!hiddenColumns.includes("status") ? <th>Status</th> : null}
                    {!hiddenColumns.includes("appliedDate") ? <th>Applied</th> : null}
                    {!hiddenColumns.includes("nextAction") ? <th>To do</th> : null}
                    {visibleCustomColumns.map((column) => (
                      <th key={column.id}>{column.label}</th>
                    ))}
                    {!hiddenColumns.includes("notes") ? <th>Notes</th> : null}
                    <th className="icon-column" />
                  </tr>
                </thead>
                <tbody>
                  {records.map((record) => (
                    <tr
                      key={record.id}
                      className={editingRowId === record.id ? "table-row-editing" : "table-row"}
                    >
                      {!hiddenColumns.includes("company") ? <td>
                        {editingRowId === record.id && editingDraft ? (
                          renderEditingInput(editingDraft.company, (value) => updateEditingDraft("company", value))
                        ) : (
                          renderPrimaryCell(record.company, record.location)
                        )}
                      </td> : null}
                      {!hiddenColumns.includes("role") ? <td>
                        {editingRowId === record.id && editingDraft ? (
                          renderEditingInput(editingDraft.role, (value) => updateEditingDraft("role", value))
                        ) : (
                          renderPrimaryCell(record.role, record.source)
                        )}
                      </td> : null}
                      {!hiddenColumns.includes("status") ? <td>
                        {editingRowId === record.id && editingDraft ? (
                          <div className="status-edit-control">
                            <select
                              value={editingDraft.status}
                              onChange={(event) => updateEditingDraft("status", event.target.value)}
                            >
                              {statusOptions.map((status) => (
                                <option key={status} value={status}>
                                  {status}
                                </option>
                              ))}
                            </select>
                            {isAddingStatus ? (
                              <div className="status-add-row">
                                <input
                                  value={newStatusDraft}
                                  onChange={(event) => setNewStatusDraft(event.target.value)}
                                  placeholder="New status"
                                />
                                <button className="ghost-button compact-button" onClick={addStatusOption}>
                                  Add
                                </button>
                                <button
                                  className="ghost-button compact-button"
                                  onClick={() => {
                                    setIsAddingStatus(false);
                                    setNewStatusDraft("");
                                  }}
                                >
                                  Cancel
                                </button>
                              </div>
                            ) : (
                              <button
                                className="ghost-button compact-button"
                                onClick={() => setIsAddingStatus(true)}
                              >
                                New
                              </button>
                            )}
                          </div>
                        ) : (
                          <span className={`status-pill status-${slugify(record.status)}`}>
                            {record.status || "—"}
                          </span>
                        )}
                      </td> : null}
                      {!hiddenColumns.includes("appliedDate") ? <td>
                        {editingRowId === record.id && editingDraft ? (
                          renderEditingInput(
                            editingDraft.appliedDate,
                            (value) => updateEditingDraft("appliedDate", value),
                            "date",
                          )
                        ) : (
                          <span className="cell-text">{record.appliedDate || "—"}</span>
                        )}
                      </td> : null}
                      {!hiddenColumns.includes("nextAction") ? <td>
                        {editingRowId === record.id && editingDraft ? (
                          <div className="stacked-edit-fields">
                            {renderEditingInput(
                              editingDraft.nextAction,
                              (value) => updateEditingDraft("nextAction", value),
                            )}
                            {renderEditingInput(
                              editingDraft.nextActionDue,
                              (value) => updateEditingDraft("nextActionDue", value),
                              "date",
                            )}
                          </div>
                        ) : (
                          renderPrimaryCell(
                            record.nextAction || "—",
                            record.nextActionDue ? `Due ${record.nextActionDue}` : "No due date",
                          )
                        )}
                      </td> : null}
                      {visibleCustomColumns.map((column) => (
                        <td key={`${record.id}-${column.id}`}>
                          {editingRowId === record.id && editingDraft ? (
                            renderEditingInput(
                              editingDraft.customValues[column.id] ?? "",
                              (value) => updateEditingCustomValue(column.id, value),
                            )
                          ) : (
                            <span className="cell-text">{record.customValues[column.id] || "—"}</span>
                          )}
                        </td>
                      ))}
                      {!hiddenColumns.includes("notes") ? <td>
                        {editingRowId === record.id && editingDraft ? (
                          renderEditingTextarea(
                            editingDraft.notes,
                            (value) => updateEditingDraft("notes", value),
                          )
                        ) : (
                          <span className="cell-text cell-notes">{record.notes || "—"}</span>
                        )}
                      </td> : null}
                      <td className="icon-cell">
                        {editingRowId === record.id ? (
                          <div className="icon-actions">
                            <button className="ghost-button row-button compact-button" onClick={cancelEditingRow}>
                              Cancel
                            </button>
                            <button className="primary-button row-button compact-button" onClick={saveEditingRow}>
                              Save
                            </button>
                          </div>
                        ) : (
                          <button
                            className="icon-button"
                            onClick={() => startEditing(record)}
                            aria-label={`Edit ${record.company || record.role || "application"}`}
                            title="Edit row"
                          >
                            <span aria-hidden="true">✎</span>
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>

      {isColumnModalOpen ? (
        <div className="modal-backdrop" onClick={() => setIsColumnModalOpen(false)}>
          <div className="modal-panel" onClick={(event) => event.stopPropagation()}>
            <div className="section-heading modal-heading">
              <div>
                <p className="eyebrow">Columns</p>
                <h2>Edit columns</h2>
              </div>
              <button className="ghost-button" onClick={() => setIsColumnModalOpen(false)}>
                Close
              </button>
            </div>

            <div className="modal-section">
              <h3>Default columns</h3>
              <div className="modal-list">
                {configurableStandardFields.map((field) => (
                  <div key={field.key} className="modal-row">
                    <div>
                      <strong>{field.label}</strong>
                      <span>{field.helpText}</span>
                    </div>
                    <button
                      className="ghost-button"
                      onClick={() => toggleColumnVisibility(field.key)}
                    >
                      {hiddenColumns.includes(field.key) ? "Show" : "Hide"}
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <div className="modal-section">
              <h3>Custom columns</h3>
              <div className="modal-form">
                <input
                  value={newCustomColumnName}
                  onChange={(event) => setNewCustomColumnName(event.target.value)}
                  placeholder="Column name"
                />
                <input
                  value={newCustomColumnHelpText}
                  onChange={(event) => setNewCustomColumnHelpText(event.target.value)}
                  placeholder="What this column means"
                />
                <button className="primary-button" onClick={addCustomColumnFromModal}>
                  Add custom column
                </button>
              </div>
              <div className="modal-list">
                {customColumns.length > 0 ? (
                  customColumns.map((column) => {
                    const fieldKey = toCustomFieldKey(column.id);
                    return (
                      <div key={column.id} className="modal-row">
                        <div>
                          <strong>{column.label}</strong>
                          <span>{column.helpText}</span>
                        </div>
                        <div className="modal-actions">
                          <button
                            className="ghost-button"
                            onClick={() => toggleColumnVisibility(fieldKey)}
                          >
                            {hiddenColumns.includes(fieldKey) ? "Show" : "Hide"}
                          </button>
                          <button
                            className="danger-button"
                            onClick={() => removeCustomColumn(column.id)}
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <p className="modal-empty">No custom columns yet.</p>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function renderEditingInput(
  value: string,
  updateValue: (value: string) => void,
  type = "text",
) {
  return (
    <input
      type={type}
      value={value}
      onChange={(event) => updateValue(event.target.value)}
    />
  );
}

function renderEditingTextarea(value: string, updateValue: (value: string) => void) {
  return (
    <textarea
      rows={3}
      value={value}
      onChange={(event) => updateValue(event.target.value)}
    />
  );
}

function renderPrimaryCell(primary: string, secondary: string) {
  return (
    <div className="table-cell-stack">
      <strong>{primary || "—"}</strong>
      <span>{secondary || "—"}</span>
    </div>
  );
}

function loadInitialDashboard(): PersistedDashboard {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) {
    return { records: [], customColumns: [], hiddenColumns: [], statusOptions: DEFAULT_STATUS_OPTIONS };
  }

  try {
    const parsed = JSON.parse(stored) as PersistedDashboard | JobRecord[];
    if (Array.isArray(parsed)) {
      const records = parsed.map((record) => normalizeLegacyRecord(record));
      return {
        records,
        customColumns: [],
        hiddenColumns: [],
        statusOptions: buildStatusOptions(records, []),
      };
    }

    const records = Array.isArray(parsed.records)
      ? parsed.records.map((record) => normalizeLegacyRecord(record))
      : [];
    const storedStatusOptions = Array.isArray(parsed.statusOptions)
      ? parsed.statusOptions.filter((value): value is string => typeof value === "string")
      : [];

    return {
      records,
      customColumns: Array.isArray(parsed.customColumns) ? parsed.customColumns : [],
      hiddenColumns: Array.isArray(parsed.hiddenColumns) ? parsed.hiddenColumns : [],
      statusOptions: buildStatusOptions(records, storedStatusOptions),
    };
  } catch {
    return { records: [], customColumns: [], hiddenColumns: [], statusOptions: DEFAULT_STATUS_OPTIONS };
  }
}

function normalizeLegacyRecord(record: Partial<JobRecord> & Record<string, unknown>): JobRecord {
  return {
    id: typeof record.id === "string" ? record.id : crypto.randomUUID(),
    company: stringValue(record.company),
    role: stringValue(record.role),
    status: stringValue(record.status),
    appliedDate: stringValue(record.appliedDate),
    location: stringValue(record.location),
    nextAction: stringValue(record.nextAction),
    nextActionDue: stringValue(record.nextActionDue),
    notes: stringValue(record.notes),
    source: stringValue(record.source),
    link: stringValue(record.link),
    salary: stringValue(record.salary),
    lastUpdated: stringValue(record.lastUpdated),
    customValues:
      typeof record.customValues === "object" && record.customValues !== null
        ? Object.fromEntries(
            Object.entries(record.customValues as Record<string, unknown>).map(([key, value]) => [
              key,
              stringValue(value),
            ]),
          )
        : {},
  };
}

function createBlankRecord(customColumns: CustomColumn[]): JobRecord {
  return {
    id: crypto.randomUUID(),
    company: "",
    role: "",
    status: "Applied",
    appliedDate: todayIso(),
    location: "",
    nextAction: "",
    nextActionDue: "",
    notes: "",
    source: "Manual",
    link: "",
    salary: "",
    lastUpdated: todayIso(),
    customValues: Object.fromEntries(customColumns.map((column) => [column.id, ""])),
  };
}

function buildImportFields(customColumns: CustomColumn[]): ImportFieldDefinition[] {
  const standardFields: ImportFieldDefinition[] = STANDARD_FIELDS.map((field) => ({
    key: field.key,
    label: field.label,
    helpText: field.helpText,
    matchers: field.matchers,
    isDate: field.isDate,
  }));

  const customFields: ImportFieldDefinition[] = customColumns.map((column) => ({
    key: toCustomFieldKey(column.id),
    label: column.label,
    helpText: column.helpText,
    matchers: [normalizeHeader(column.label)],
    isCustom: true,
  }));

  return [...standardFields, ...customFields];
}

function buildFieldMap(headers: string[], fields: ImportFieldDefinition[]) {
  const normalizedHeaders = headers.map((header) => ({
    original: header,
    normalized: normalizeHeader(header),
  }));

  const fieldMap: Record<string, string> = {};

  fields.forEach((field) => {
    let bestHeader = "";
    let bestScore = 0;

    normalizedHeaders.forEach((header) => {
      const score = field.matchers.reduce((accumulator, matcher) => {
        if (header.normalized === matcher) {
          return accumulator + 100;
        }

        if (header.normalized.includes(matcher)) {
          return accumulator + 20;
        }

        return accumulator;
      }, 0);

      if (score > bestScore) {
        bestHeader = header.original;
        bestScore = score;
      }
    });

    fieldMap[field.key] = bestHeader;
  });

  return fieldMap;
}

function summarizeFieldMap(
  headers: string[],
  fieldMap: Record<string, string>,
  fields: ImportFieldDefinition[],
) {
  const mappedHeaders = new Set(
    fields.map((field) => fieldMap[field.key]).filter(Boolean),
  );

  return {
    mappedFields: fields
      .filter((field) => Boolean(fieldMap[field.key]))
      .map((field) => field.label),
    unmatchedColumns: headers.filter((header) => !mappedHeaders.has(header)),
  };
}

function normalizeImportedRows(
  rows: RawRow[],
  sourceLabel: string,
  fieldMap: Record<string, string>,
  dateResolutions: Partial<Record<DateFieldKey, DateResolution>>,
  customColumns: CustomColumn[],
) {
  const headers = Object.keys(rows[0] ?? {});
  const importFields = buildImportFields(customColumns);
  const mappedFields = importFields
    .filter((field) => Boolean(fieldMap[field.key]))
    .map((field) => field.label);

  const mappedHeaders = new Set(
    importFields.map((field) => fieldMap[field.key]).filter(Boolean),
  );
  const unmatchedColumns = headers.filter((header) => !mappedHeaders.has(header));

  let ambiguousDateCount = 0;
  const sequenceState = initializeSequenceState(dateResolutions);

  const records = rows
    .map((row) => {
      const appliedDate = normalizeDate(readMappedValue(row, fieldMap.appliedDate));
      const nextActionDue = normalizeDate(readMappedValue(row, fieldMap.nextActionDue));
      const lastUpdated = normalizeDate(readMappedValue(row, fieldMap.lastUpdated));

      const resolvedAppliedDate = applyDateResolution(
        "appliedDate",
        appliedDate,
        dateResolutions,
        sequenceState,
      );
      const resolvedNextActionDue = applyDateResolution(
        "nextActionDue",
        nextActionDue,
        dateResolutions,
        sequenceState,
      );
      const resolvedLastUpdated = applyDateResolution(
        "lastUpdated",
        lastUpdated,
        dateResolutions,
        sequenceState,
      );

      ambiguousDateCount += Number(resolvedAppliedDate.wasAmbiguous);
      ambiguousDateCount += Number(resolvedNextActionDue.wasAmbiguous);
      ambiguousDateCount += Number(resolvedLastUpdated.wasAmbiguous);

      const customValues = Object.fromEntries(
        customColumns.map((column) => [
          column.id,
          readMappedValue(row, fieldMap[toCustomFieldKey(column.id)]),
        ]),
      );

      return {
        id: crypto.randomUUID(),
        company: readMappedValue(row, fieldMap.company),
        role: readMappedValue(row, fieldMap.role),
        status: normalizeStatus(readMappedValue(row, fieldMap.status)),
        appliedDate: resolvedAppliedDate.value,
        location: readMappedValue(row, fieldMap.location),
        nextAction: readMappedValue(row, fieldMap.nextAction),
        nextActionDue: resolvedNextActionDue.value,
        notes: readMappedValue(row, fieldMap.notes),
        source: readMappedValue(row, fieldMap.source) || sourceLabel,
        link: readMappedValue(row, fieldMap.link),
        salary: readMappedValue(row, fieldMap.salary),
        lastUpdated: resolvedLastUpdated.value || todayIso(),
        customValues,
      } satisfies JobRecord;
    })
    .filter((record) => record.company || record.role || record.notes);

  return {
    records,
    summary: {
      importedCount: records.length,
      mappedFields,
      unmatchedColumns,
      ambiguousDateCount,
    } satisfies ImportSummary,
  };
}

function inspectAmbiguousDates(
  rows: RawRow[],
  fieldMap: Record<string, string>,
  _dateResolutions: Partial<Record<DateFieldKey, DateResolution>>,
) {
  const dateFields: DateFieldKey[] = ["appliedDate", "nextActionDue", "lastUpdated"];
  const previews: AmbiguousDatePreview[] = [];

  dateFields.forEach((field) => {
    const header = fieldMap[field];
    if (!header) {
      return;
    }

    const samples = new Set<string>();
    let count = 0;
    let wrapCount = 0;
    let previousComparable: number | null = null;

    rows.forEach((row) => {
      const rawValue = readMappedValue(row, header);
      if (!rawValue) {
        return;
      }

      const normalized = normalizeDate(rawValue);
      if (normalized.wasAmbiguous) {
        count += 1;
        if (samples.size < 3) {
          samples.add(rawValue);
        }

        const comparable = getMonthDayComparable(rawValue);
        if (comparable !== null && previousComparable !== null && comparable < previousComparable) {
          wrapCount += 1;
        }

        if (comparable !== null) {
          previousComparable = comparable;
        }
      }
    });

    if (count > 0) {
      previews.push({
        field,
        header,
        count,
        samples: Array.from(samples),
        supportsSequence: wrapCount > 0,
        wrapCount,
      });
    }
  });

  return previews;
}

function readMappedValue(row: RawRow, header: string) {
  if (!header) {
    return "";
  }

  const value = row[header];
  return typeof value === "string" ? value.trim() : String(value ?? "").trim();
}

function guessHeaderForCustomField(headers: string[], column: CustomColumn) {
  const normalizedLabel = normalizeHeader(column.label);
  const matches = headers.find((header) => normalizeHeader(header) === normalizedLabel);
  return matches ?? "";
}

function normalizeHeader(header: string) {
  return header.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeStatus(value: string) {
  const normalized = value.toLowerCase();
  if (normalized.includes("offer")) {
    return "Offer";
  }
  if (normalized.includes("reject")) {
    return "Rejected";
  }
  if (normalized.includes("take") || normalized.includes("assessment")) {
    return "Take-home";
  }
  if (normalized.includes("interview") || normalized.includes("onsite") || normalized.includes("screen")) {
    return "Interviewing";
  }
  if (normalized.includes("appl")) {
    return "Applied";
  }
  return value || "Applied";
}

function normalizeDate(value: string) {
  if (!value) {
    return { value: "", wasAmbiguous: false };
  }

  const trimmed = value.trim();
  if (isMonthDayWithoutYear(trimmed)) {
    return { value: trimmed, wasAmbiguous: true };
  }

  if (!hasExplicitYear(trimmed) && /[/-]/.test(trimmed)) {
    return { value: trimmed, wasAmbiguous: true };
  }

  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    return { value: trimmed, wasAmbiguous: false };
  }

  return { value: date.toISOString().slice(0, 10), wasAmbiguous: false };
}

function applyDateResolution(
  field: DateFieldKey,
  normalized: { value: string; wasAmbiguous: boolean },
  dateResolutions: Partial<Record<DateFieldKey, DateResolution>>,
  sequenceState: Partial<Record<DateFieldKey, { currentYear: number; previousComparable: number | null }>>,
) {
  if (!normalized.wasAmbiguous) {
    return normalized;
  }

  const resolution = dateResolutions[field];
  if (!resolution) {
    return normalized;
  }

  if (resolution.kind === "nearestPast") {
    return {
      value: applyNearestPastYear(normalized.value),
      wasAmbiguous: false,
    };
  }

  if (resolution.kind === "sequence") {
    if (!resolution.startYear) {
      return normalized;
    }

    return {
      value: applySequenceYear(field, normalized.value, sequenceState),
      wasAmbiguous: false,
    };
  }

  const resolved = normalizeDate(`${normalized.value}/${resolution.year}`);
  return {
    value: resolved.value,
    wasAmbiguous: false,
  };
}

function initializeSequenceState(dateResolutions: Partial<Record<DateFieldKey, DateResolution>>) {
  const state: Partial<
    Record<DateFieldKey, { currentYear: number; previousComparable: number | null }>
  > = {};

  (Object.entries(dateResolutions) as Array<[DateFieldKey, DateResolution]>).forEach(
    ([field, resolution]) => {
      if (resolution.kind === "sequence" && resolution.startYear) {
        state[field] = {
          currentYear: Number(resolution.startYear),
          previousComparable: null,
        };
      }
    },
  );

  return state;
}

function applyNearestPastYear(value: string) {
  const match = value.match(/^(\d{1,2})[/-](\d{1,2})$/);
  if (!match) {
    return value;
  }

  const month = Number(match[1]);
  const day = Number(match[2]);
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  const currentDay = now.getDate();
  const resolvedYear =
    month > currentMonth || (month === currentMonth && day > currentDay)
      ? currentYear - 1
      : currentYear;

  return `${resolvedYear}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function applySequenceYear(
  field: DateFieldKey,
  value: string,
  sequenceState: Partial<Record<DateFieldKey, { currentYear: number; previousComparable: number | null }>>,
) {
  const state = sequenceState[field];
  const match = value.match(/^(\d{1,2})[/-](\d{1,2})$/);
  if (!state || !match) {
    return value;
  }

  const month = Number(match[1]);
  const day = Number(match[2]);
  const comparable = month * 100 + day;

  if (state.previousComparable !== null && comparable < state.previousComparable) {
    state.currentYear += 1;
  }

  state.previousComparable = comparable;
  return `${state.currentYear}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function buildResolutionYears() {
  const currentYear = new Date().getFullYear();
  return Array.from({ length: 10 }, (_, index) => String(currentYear - 4 + index));
}

function resolveYearForStrategy(strategy: "current" | "nearestPast") {
  const currentYear = new Date().getFullYear();
  if (strategy === "current") {
    return { kind: "year", year: String(currentYear) } satisfies DateResolution;
  }

  return { kind: "nearestPast" } satisfies DateResolution;
}

function getMonthDayComparable(value: string) {
  const match = value.match(/^(\d{1,2})[/-](\d{1,2})$/);
  if (!match) {
    return null;
  }

  return Number(match[1]) * 100 + Number(match[2]);
}

function isMonthDayWithoutYear(value: string) {
  return /^(0?[1-9]|1[0-2])[/-](0?[1-9]|[12][0-9]|3[01])$/.test(value);
}

function hasExplicitYear(value: string) {
  const parts = value.split(/[/-]/).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 3) {
    return false;
  }

  const lastPart = parts[parts.length - 1] ?? "";
  return /^\d{4}$/.test(lastPart) || /^\d{2}$/.test(lastPart);
}

function mergeRecords(current: JobRecord[], imported: JobRecord[]) {
  const existingKeys = new Set(
    current.map((record) => `${record.company.toLowerCase()}::${record.role.toLowerCase()}`),
  );

  const merged = [...current];
  imported.forEach((record) => {
    const key = `${record.company.toLowerCase()}::${record.role.toLowerCase()}`;
    if (!existingKeys.has(key)) {
      merged.unshift(record);
      existingKeys.add(key);
    }
  });

  return merged;
}

function computeStats(records: JobRecord[]) {
  const total = records.length;
  const interviewing = records.filter((record) =>
    ["interviewing", "take-home", "offer"].includes(record.status.toLowerCase()),
  ).length;
  const offers = records.filter((record) => record.status.toLowerCase().includes("offer")).length;
  const rejected = records.filter((record) => record.status.toLowerCase().includes("reject")).length;
  const openTasks = records.filter((record) => record.nextAction.trim()).length;
  const interviewRate = total === 0 ? 0 : Math.round((interviewing / total) * 100);

  return {
    total,
    openTasks,
    interviewRate,
    cards: [
      { label: "In process", value: interviewing },
      { label: "Offers", value: offers },
      { label: "Rejected", value: rejected },
      { label: "Needs follow-up", value: openTasks },
    ],
  };
}

function isActiveProcess(status: string) {
  const value = status.toLowerCase();
  return (
    !value.includes("reject") &&
    !value.includes("withdraw") &&
    !value.includes("ghost") &&
    !value.includes("offer accepted") &&
    (value.includes("interview") || value.includes("onsite") || value.includes("take-home") || value.includes("assessment") || value.includes("offer"))
  );
}

function toGoogleSheetCsvUrl(input: string) {
  try {
    const url = new URL(input);
    if (url.hostname.includes("docs.google.com") && url.pathname.includes("/spreadsheets/d/")) {
      const parts = url.pathname.split("/");
      const sheetId = parts[3];
      const gid = url.searchParams.get("gid") ?? "0";
      return `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
    }

    if (input.endsWith(".csv")) {
      return input;
    }
  } catch {
    return "";
  }

  return "";
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : String(value ?? "");
}

function buildStatusOptions(records: JobRecord[], storedStatusOptions: string[]) {
  const next = new Set(DEFAULT_STATUS_OPTIONS);
  storedStatusOptions.forEach((status) => {
    if (status.trim()) {
      next.add(status.trim());
    }
  });
  records.forEach((record) => {
    if (record.status.trim()) {
      next.add(record.status.trim());
    }
  });
  return Array.from(next);
}

function toCustomFieldKey(columnId: string) {
  return `custom:${columnId}` as const;
}

function stripCustomPrefix(fieldKey: FieldKey) {
  return fieldKey.replace(/^custom:/, "");
}

function labelForStandardField(field: DateFieldKey) {
  return STANDARD_FIELDS.find((item) => item.key === field)?.label ?? field;
}

function getResolutionMode(resolution?: DateResolution) {
  if (!resolution) {
    return "keep";
  }
  if (resolution.kind === "nearestPast") {
    return "nearestPast";
  }
  if (resolution.kind === "sequence") {
    return "sequence";
  }
  return "year";
}

function getResolutionYear(resolution?: DateResolution) {
  if (!resolution) {
    return null;
  }
  if (resolution.kind === "year") {
    return resolution.year;
  }
  if (resolution.kind === "sequence") {
    return resolution.startYear;
  }
  return null;
}

export default App;
