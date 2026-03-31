import { ChangeEvent, useEffect, useMemo, useState } from "react";

type JobRecord = {
  id: string;
  company: string;
  role: string;
  status: string;
  stage: string;
  appliedDate: string;
  location: string;
  recruiter: string;
  nextAction: string;
  nextActionDue: string;
  notes: string;
  source: string;
  link: string;
  salary: string;
  lastUpdated: string;
};

type ImportSummary = {
  importedCount: number;
  mappedFields: string[];
  unmatchedColumns: string[];
  ambiguousDateCount: number;
};

type RawRow = Record<string, unknown>;
type FieldKey = keyof Omit<JobRecord, "id">;

type PendingImport = {
  rows: RawRow[];
  sourceLabel: string;
  headers: string[];
  fieldMap: Record<FieldKey, string>;
  dateResolutions: Partial<Record<FieldKey, string | "nearestPast">>;
};

type AmbiguousDatePreview = {
  field: FieldKey;
  header: string;
  count: number;
  samples: string[];
};

const STORAGE_KEY = "job-dashboard-records";

const fieldLabels: Record<FieldKey, string> = {
  company: "Company",
  role: "Role",
  status: "Status",
  stage: "Stage",
  appliedDate: "Applied date",
  location: "Location",
  recruiter: "Recruiter",
  nextAction: "Next action",
  nextActionDue: "Next action due",
  notes: "Notes",
  source: "Source",
  link: "Job link",
  salary: "Salary",
  lastUpdated: "Last updated",
};

const fieldMatchers: Record<keyof Omit<JobRecord, "id">, string[]> = {
  company: ["company", "employer", "organization", "org"],
  role: ["role", "title", "position", "job", "job title"],
  status: ["status", "application status", "state", "outcome"],
  stage: ["stage", "interview stage", "pipeline", "process"],
  appliedDate: ["applied", "application date", "date applied", "submitted"],
  location: ["location", "city", "remote", "hybrid"],
  recruiter: ["recruiter", "contact", "hiring manager", "talent", "owner"],
  nextAction: ["todo", "to do", "next step", "action item", "follow up", "task"],
  nextActionDue: ["due", "deadline", "next action due", "follow up by"],
  notes: ["notes", "comment", "details", "summary"],
  source: ["source", "referral", "board", "where found"],
  link: ["link", "url", "posting", "job link"],
  salary: ["salary", "comp", "compensation", "pay"],
  lastUpdated: ["updated", "last touch", "last update", "recent touch"],
};

const FIELD_KEYS = Object.keys(fieldMatchers) as FieldKey[];

function App() {
  const [records, setRecords] = useState<JobRecord[]>(() => loadInitialRecords());
  const [googleSheetUrl, setGoogleSheetUrl] = useState("");
  const [importMessage, setImportMessage] = useState<string>("");
  const [isFetchingSheet, setIsFetchingSheet] = useState(false);
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null);
  const [editingRowId, setEditingRowId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState<JobRecord | null>(null);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  }, [records]);

  const stats = useMemo(() => computeStats(records), [records]);
  const activeInterviews = useMemo(
    () => records.filter((record) => isActiveProcess(record.status, record.stage)),
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
      fieldMap: buildFieldMap(headers),
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

  function updatePendingDateResolution(field: FieldKey, year: string) {
    setPendingImport((current) =>
      current
        ? {
            ...current,
            dateResolutions: {
              ...current.dateResolutions,
              [field]: year,
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

      const nextResolutions: Partial<Record<FieldKey, string | "nearestPast">> = {
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

  function startEditing(record: JobRecord) {
    setEditingRowId(record.id);
    setEditingDraft({ ...record });
  }

  function updateEditingDraft(field: FieldKey, value: string) {
    setEditingDraft((current) =>
      current
        ? {
            ...current,
            [field]: value,
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
              lastUpdated: editingDraft.lastUpdated || todayIso(),
            }
          : record,
      ),
    );
    setEditingRowId(null);
    setEditingDraft(null);
  }

  function cancelEditingRow() {
    setEditingRowId(null);
    setEditingDraft(null);
  }

  function addBlankRecord() {
    const newRecord = {
      id: crypto.randomUUID(),
      company: "",
      role: "",
      status: "Applied",
      stage: "",
      appliedDate: todayIso(),
      location: "",
      recruiter: "",
      nextAction: "",
      nextActionDue: "",
      notes: "",
      source: "Manual",
      link: "",
      salary: "",
      lastUpdated: todayIso(),
    };

    setRecords((current) => [
      newRecord,
      ...current,
    ]);
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
    setPendingImport(null);
    setEditingRowId(null);
    setEditingDraft(null);
    setGoogleSheetUrl("");
    setImportMessage("All saved data was cleared. Import a new sheet to start again.");
  }

  const pendingImportPreview = useMemo(() => {
    if (!pendingImport) {
      return [];
    }

    return pendingImport.rows.slice(0, 3);
  }, [pendingImport]);

  const pendingImportSummary = useMemo(() => {
    if (!pendingImport) {
      return null;
    }

    return summarizeFieldMap(pendingImport.headers, pendingImport.fieldMap);
  }, [pendingImport]);

  const pendingAmbiguousDates = useMemo(() => {
    if (!pendingImport) {
      return [];
    }

    return inspectAmbiguousDates(
      pendingImport.rows,
      pendingImport.fieldMap,
      pendingImport.dateResolutions,
    );
  }, [pendingImport]);

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

          {records.length > 0 ? (
            <div className="danger-zone">
              <button className="danger-button" onClick={clearAllData}>
                Clear all data
              </button>
              <span>Wipes the current dashboard so you can import a new tracker.</span>
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
                    Choose a year for any values you want normalized. Leave a value unresolved if
                    you want the app to preserve it exactly as written.
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
                  </div>
                  <div className="resolution-list">
                    {pendingAmbiguousDates.map((item) => (
                      <div key={item.field} className="resolution-item">
                        <div>
                          <strong>
                            {fieldLabels[item.field]}
                          </strong>
                          <span>
                            {item.count} ambiguous value{item.count === 1 ? "" : "s"} in column
                            {` "${item.header}"`}
                          </span>
                          <span>Examples: {item.samples.join(", ")}</span>
                        </div>
                        <select
                          value={pendingImport.dateResolutions[item.field] ?? ""}
                          onChange={(event) =>
                            updatePendingDateResolution(item.field, event.target.value)
                          }
                        >
                          <option value="">Keep as written</option>
                          <option value="nearestPast">Use nearest past year</option>
                          {resolutionYears.map((year) => (
                            <option key={`${item.field}-${year}`} value={year}>
                              Use {year} for all
                            </option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="mapping-grid">
                {FIELD_KEYS.map((field) => (
                  <label key={field} className="mapping-card">
                    <span>{fieldLabels[field]}</span>
                    <select
                      value={pendingImport.fieldMap[field]}
                      onChange={(event) => updatePendingImportField(field, event.target.value)}
                    >
                      <option value="">Leave unmapped</option>
                      {pendingImport.headers.map((header) => (
                        <option key={`${field}-${header}`} value={header}>
                          {header}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>

              <div className="mapping-preview-grid">
                <div className="mapping-preview-card">
                  <h3>Unmatched columns</h3>
                  <div className="mapping-tags">
                    {pendingImportSummary.unmatchedColumns.length > 0 ? (
                      pendingImportSummary.unmatchedColumns.map((column) => (
                        <span key={column} className="tag">
                          {column}
                        </span>
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
                    <span>{record.stage || record.status}</span>
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
                    <th>Company</th>
                    <th>Role</th>
                    <th>Status</th>
                    <th>Stage</th>
                    <th>Applied</th>
                    <th>To do</th>
                    <th>Recruiter</th>
                    <th>Updated</th>
                    <th>Actions</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {records.map((record) => (
                    <tr
                      key={record.id}
                      className={editingRowId === record.id ? "table-row-editing" : "table-row"}
                    >
                      <td>
                        {editingRowId === record.id && editingDraft ? (
                          renderEditingInput(editingDraft, "company", updateEditingDraft)
                        ) : (
                          renderPrimaryCell(record.company, record.location)
                        )}
                      </td>
                      <td>
                        {editingRowId === record.id && editingDraft ? (
                          renderEditingInput(editingDraft, "role", updateEditingDraft)
                        ) : (
                          renderPrimaryCell(record.role, record.source)
                        )}
                      </td>
                      <td>
                        {editingRowId === record.id && editingDraft ? (
                          renderEditingInput(editingDraft, "status", updateEditingDraft)
                        ) : (
                          <span className={`status-pill status-${slugify(record.status)}`}>
                            {record.status || "—"}
                          </span>
                        )}
                      </td>
                      <td>
                        {editingRowId === record.id && editingDraft ? (
                          renderEditingInput(editingDraft, "stage", updateEditingDraft)
                        ) : (
                          <span className="cell-text">{record.stage || "—"}</span>
                        )}
                      </td>
                      <td>
                        {editingRowId === record.id && editingDraft ? (
                          <div className="stacked-edit-fields">
                            {renderEditingInput(editingDraft, "appliedDate", updateEditingDraft, "date")}
                            {renderEditingInput(editingDraft, "nextActionDue", updateEditingDraft, "date")}
                          </div>
                        ) : (
                          renderPrimaryCell(
                            record.appliedDate || "—",
                            record.nextActionDue ? `Due ${record.nextActionDue}` : "No due date",
                          )
                        )}
                      </td>
                      <td>
                        {editingRowId === record.id && editingDraft ? (
                          renderEditingInput(editingDraft, "nextAction", updateEditingDraft)
                        ) : (
                          <span className="cell-text">{record.nextAction || "—"}</span>
                        )}
                      </td>
                      <td>
                        {editingRowId === record.id && editingDraft ? (
                          renderEditingInput(editingDraft, "recruiter", updateEditingDraft)
                        ) : (
                          <span className="cell-text">{record.recruiter || "—"}</span>
                        )}
                      </td>
                      <td>
                        {editingRowId === record.id && editingDraft ? (
                          renderEditingInput(editingDraft, "lastUpdated", updateEditingDraft, "date")
                        ) : (
                          <span className="cell-text">{record.lastUpdated || "—"}</span>
                        )}
                      </td>
                      <td>
                        {editingRowId === record.id ? (
                          <div className="row-actions">
                            <button className="ghost-button row-button" onClick={cancelEditingRow}>
                              Cancel
                            </button>
                            <button className="primary-button row-button" onClick={saveEditingRow}>
                              Save
                            </button>
                          </div>
                        ) : (
                          <button
                            className="ghost-button row-button"
                            onClick={() => startEditing(record)}
                          >
                            Edit
                          </button>
                        )}
                      </td>
                      <td>
                        {editingRowId === record.id && editingDraft ? (
                          renderEditingTextarea(editingDraft, "notes", updateEditingDraft)
                        ) : (
                          <span className="cell-text cell-notes">{record.notes || "—"}</span>
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
    </div>
  );
}

function renderEditingInput(
  record: JobRecord,
  field: FieldKey,
  updateRecord: (field: FieldKey, value: string) => void,
  type = "text",
) {
  return (
    <input
      type={type}
      value={record[field]}
      onChange={(event) => updateRecord(field, event.target.value)}
    />
  );
}

function renderEditingTextarea(
  record: JobRecord,
  field: FieldKey,
  updateRecord: (field: FieldKey, value: string) => void,
) {
  return (
    <textarea
      rows={3}
      value={record[field]}
      onChange={(event) => updateRecord(field, event.target.value)}
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

function loadInitialRecords() {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) {
    return [];
  }

  try {
    const parsed = JSON.parse(stored) as JobRecord[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeImportedRows(
  rows: RawRow[],
  sourceLabel: string,
  fieldMap: Record<FieldKey, string>,
  dateResolutions: Partial<Record<FieldKey, string | "nearestPast">>,
) {
  const headers = Object.keys(rows[0] ?? {});
  const mappedFields = Object.entries(fieldMap)
    .filter(([, header]) => Boolean(header))
    .map(([field]) => field);

  const unmatchedColumns = headers.filter(
    (header) => !Object.values(fieldMap).includes(header),
  );

  let ambiguousDateCount = 0;

  const records = rows
    .map((row) => {
      const appliedDate = normalizeDate(readMappedValue(row, fieldMap.appliedDate));
      const nextActionDue = normalizeDate(readMappedValue(row, fieldMap.nextActionDue));
      const lastUpdated = normalizeDate(readMappedValue(row, fieldMap.lastUpdated));

      const resolvedAppliedDate = applyDateResolution(
        "appliedDate",
        appliedDate,
        dateResolutions,
      );
      const resolvedNextActionDue = applyDateResolution(
        "nextActionDue",
        nextActionDue,
        dateResolutions,
      );
      const resolvedLastUpdated = applyDateResolution(
        "lastUpdated",
        lastUpdated,
        dateResolutions,
      );

      ambiguousDateCount += Number(resolvedAppliedDate.wasAmbiguous);
      ambiguousDateCount += Number(resolvedNextActionDue.wasAmbiguous);
      ambiguousDateCount += Number(resolvedLastUpdated.wasAmbiguous);

      const record: JobRecord = {
        id: crypto.randomUUID(),
        company: readMappedValue(row, fieldMap.company),
        role: readMappedValue(row, fieldMap.role),
        status: normalizeStatus(readMappedValue(row, fieldMap.status)),
        stage: readMappedValue(row, fieldMap.stage),
        appliedDate: resolvedAppliedDate.value,
        location: readMappedValue(row, fieldMap.location),
        recruiter: readMappedValue(row, fieldMap.recruiter),
        nextAction: readMappedValue(row, fieldMap.nextAction),
        nextActionDue: resolvedNextActionDue.value,
        notes: readMappedValue(row, fieldMap.notes),
        source: readMappedValue(row, fieldMap.source) || sourceLabel,
        link: readMappedValue(row, fieldMap.link),
        salary: readMappedValue(row, fieldMap.salary),
        lastUpdated: resolvedLastUpdated.value || todayIso(),
      };

      if (!record.stage && record.status) {
        record.stage = record.status;
      }

      return record;
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

function buildFieldMap(headers: string[]) {
  const normalizedHeaders = headers.map((header) => ({
    original: header,
    normalized: normalizeHeader(header),
  }));

  const fieldMap = {} as Record<FieldKey, string>;

  FIELD_KEYS.forEach((field) => {
    let bestHeader = "";
    let bestScore = 0;

    normalizedHeaders.forEach((header) => {
      const score = fieldMatchers[field].reduce((accumulator, matcher) => {
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

    fieldMap[field] = bestHeader;
  });

  return fieldMap;
}

function summarizeFieldMap(headers: string[], fieldMap: Record<FieldKey, string>) {
  return {
    mappedFields: Object.entries(fieldMap)
      .filter(([, header]) => Boolean(header))
      .map(([field]) => field),
    unmatchedColumns: headers.filter((header) => !Object.values(fieldMap).includes(header)),
  };
}

function inspectAmbiguousDates(
  rows: RawRow[],
  fieldMap: Record<FieldKey, string>,
  dateResolutions: Partial<Record<FieldKey, string | "nearestPast">>,
) {
  const dateFields: FieldKey[] = ["appliedDate", "nextActionDue", "lastUpdated"];
  const previews: AmbiguousDatePreview[] = [];

  dateFields.forEach((field) => {
    const header = fieldMap[field];
    if (!header || dateResolutions[field]) {
      return;
    }

    const samples = new Set<string>();
    let count = 0;

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
      }
    });

    if (count > 0) {
      previews.push({
        field,
        header,
        count,
        samples: Array.from(samples),
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
  field: FieldKey,
  normalized: { value: string; wasAmbiguous: boolean },
  dateResolutions: Partial<Record<FieldKey, string | "nearestPast">>,
) {
  if (!normalized.wasAmbiguous) {
    return normalized;
  }

  const year = dateResolutions[field];
  if (!year) {
    return normalized;
  }

  if (year === "nearestPast") {
    return {
      value: applyNearestPastYear(normalized.value),
      wasAmbiguous: false,
    };
  }

  const resolved = normalizeDate(`${normalized.value}/${year}`);
  return {
    value: resolved.value,
    wasAmbiguous: false,
  };
}

function buildResolutionYears() {
  const currentYear = new Date().getFullYear();
  return Array.from({ length: 8 }, (_, index) => String(currentYear - 2 + index));
}

function resolveYearForStrategy(strategy: "current" | "nearestPast") {
  const currentYear = new Date().getFullYear();
  if (strategy === "current") {
    return String(currentYear);
  }

  return "nearestPast";
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

function isActiveProcess(status: string, stage: string) {
  const value = `${status} ${stage}`.toLowerCase();
  return (
    !value.includes("reject") &&
    !value.includes("withdraw") &&
    !value.includes("ghost") &&
    !value.includes("offer accepted") &&
    (value.includes("interview") || value.includes("onsite") || value.includes("take-home") || value.includes("assessment"))
  );
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

function todayIso() {
  return new Date().toISOString().slice(0, 10);
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

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

export default App;
