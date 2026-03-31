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
};

type RawRow = Record<string, unknown>;

const STORAGE_KEY = "job-dashboard-records";

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

const starterData: JobRecord[] = [
  {
    id: crypto.randomUUID(),
    company: "Northstar AI",
    role: "Frontend Engineer",
    status: "Interviewing",
    stage: "Onsite Loop",
    appliedDate: "2026-03-10",
    location: "Remote",
    recruiter: "Alex Chen",
    nextAction: "Send recruiter availability for final panel",
    nextActionDue: "2026-04-02",
    notes: "Team is moving quickly. Product sense round done.",
    source: "Referral",
    link: "",
    salary: "$155k - $180k",
    lastUpdated: "2026-03-29",
  },
  {
    id: crypto.randomUUID(),
    company: "Verdant Labs",
    role: "Product Engineer",
    status: "Applied",
    stage: "Application Review",
    appliedDate: "2026-03-18",
    location: "San Francisco, CA",
    recruiter: "",
    nextAction: "Tailor portfolio case study",
    nextActionDue: "2026-04-04",
    notes: "Need stronger narrative around analytics work.",
    source: "Company site",
    link: "",
    salary: "",
    lastUpdated: "2026-03-20",
  },
  {
    id: crypto.randomUUID(),
    company: "Kite Commerce",
    role: "Software Engineer",
    status: "Take-home",
    stage: "Technical Assessment",
    appliedDate: "2026-03-05",
    location: "Hybrid",
    recruiter: "Maya Patel",
    nextAction: "Finish coding take-home assignment",
    nextActionDue: "2026-04-01",
    notes: "Assessment window closes tomorrow.",
    source: "LinkedIn",
    link: "",
    salary: "",
    lastUpdated: "2026-03-30",
  },
];

function App() {
  const [records, setRecords] = useState<JobRecord[]>(() => loadInitialRecords());
  const [googleSheetUrl, setGoogleSheetUrl] = useState("");
  const [importMessage, setImportMessage] = useState<string>("");
  const [isFetchingSheet, setIsFetchingSheet] = useState(false);

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

      applyImportedRows(parseResult.data, "Google Sheets");
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
          complete: (result) => applyImportedRows(result.data, file.name),
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
        applyImportedRows(rows, file.name);
      };
      reader.readAsArrayBuffer(file);
    }

    event.target.value = "";
  }

  function applyImportedRows(rows: RawRow[], sourceLabel: string) {
    const result = normalizeImportedRows(rows, sourceLabel);
    setRecords((current) => mergeRecords(current, result.records));
    setImportMessage(
      `Imported ${result.summary.importedCount} rows. Mapped ${result.summary.mappedFields.join(", ") || "no known fields"}.`,
    );
  }

  function updateRecord(id: string, field: keyof Omit<JobRecord, "id">, value: string) {
    setRecords((current) =>
      current.map((record) =>
        record.id === id
          ? {
              ...record,
              [field]: value,
              lastUpdated: field === "lastUpdated" ? value : todayIso(),
            }
          : record,
      ),
    );
  }

  function addBlankRecord() {
    setRecords((current) => [
      {
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
      },
      ...current,
    ]);
  }

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
                  <th>Due</th>
                  <th>Recruiter</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {records.map((record) => (
                  <tr key={record.id}>
                    <td>{renderInput(record, "company", updateRecord)}</td>
                    <td>{renderInput(record, "role", updateRecord)}</td>
                    <td>{renderInput(record, "status", updateRecord)}</td>
                    <td>{renderInput(record, "stage", updateRecord)}</td>
                    <td>{renderInput(record, "appliedDate", updateRecord, "date")}</td>
                    <td>{renderInput(record, "nextAction", updateRecord)}</td>
                    <td>{renderInput(record, "nextActionDue", updateRecord, "date")}</td>
                    <td>{renderInput(record, "recruiter", updateRecord)}</td>
                    <td>{renderTextarea(record, "notes", updateRecord)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}

function renderInput(
  record: JobRecord,
  field: keyof Omit<JobRecord, "id">,
  updateRecord: (id: string, field: keyof Omit<JobRecord, "id">, value: string) => void,
  type = "text",
) {
  return (
    <input
      type={type}
      value={record[field]}
      onChange={(event) => updateRecord(record.id, field, event.target.value)}
    />
  );
}

function renderTextarea(
  record: JobRecord,
  field: keyof Omit<JobRecord, "id">,
  updateRecord: (id: string, field: keyof Omit<JobRecord, "id">, value: string) => void,
) {
  return (
    <textarea
      rows={3}
      value={record[field]}
      onChange={(event) => updateRecord(record.id, field, event.target.value)}
    />
  );
}

function loadInitialRecords() {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) {
    return starterData;
  }

  try {
    const parsed = JSON.parse(stored) as JobRecord[];
    return parsed.length > 0 ? parsed : starterData;
  } catch {
    return starterData;
  }
}

function normalizeImportedRows(rows: RawRow[], sourceLabel: string) {
  const headers = Object.keys(rows[0] ?? {});
  const fieldMap = buildFieldMap(headers);
  const mappedFields = Object.entries(fieldMap)
    .filter(([, header]) => Boolean(header))
    .map(([field]) => field);

  const unmatchedColumns = headers.filter(
    (header) => !Object.values(fieldMap).includes(header),
  );

  const records = rows
    .map((row) => {
      const record: JobRecord = {
        id: crypto.randomUUID(),
        company: readMappedValue(row, fieldMap.company),
        role: readMappedValue(row, fieldMap.role),
        status: normalizeStatus(readMappedValue(row, fieldMap.status)),
        stage: readMappedValue(row, fieldMap.stage),
        appliedDate: normalizeDate(readMappedValue(row, fieldMap.appliedDate)),
        location: readMappedValue(row, fieldMap.location),
        recruiter: readMappedValue(row, fieldMap.recruiter),
        nextAction: readMappedValue(row, fieldMap.nextAction),
        nextActionDue: normalizeDate(readMappedValue(row, fieldMap.nextActionDue)),
        notes: readMappedValue(row, fieldMap.notes),
        source: readMappedValue(row, fieldMap.source) || sourceLabel,
        link: readMappedValue(row, fieldMap.link),
        salary: readMappedValue(row, fieldMap.salary),
        lastUpdated: normalizeDate(readMappedValue(row, fieldMap.lastUpdated)) || todayIso(),
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
    } satisfies ImportSummary,
  };
}

function buildFieldMap(headers: string[]) {
  const normalizedHeaders = headers.map((header) => ({
    original: header,
    normalized: normalizeHeader(header),
  }));

  const fieldMap = {} as Record<keyof Omit<JobRecord, "id">, string>;

  (Object.keys(fieldMatchers) as Array<keyof Omit<JobRecord, "id">>).forEach((field) => {
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
    return "";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toISOString().slice(0, 10);
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

export default App;
