import type { DocSpec } from "./docBuilder";

export interface Template {
  id: string;
  name: string;
  description: string;
  spec: DocSpec;
}

const STAGES = ["Lead", "Qualified", "Proposal", "Won", "Lost"];
const currency = { numMode: "currency" as const, currency: "USD", decimals: 0 };

const crm: DocSpec = {
  name: "Lightweight CRM",
  tables: [
    {
      name: "Companies",
      columns: [
        { label: "Name", type: "Text" },
        { label: "Industry", type: "Choice", options: { choices: ["Software", "Retail", "Healthcare", "Finance", "Manufacturing"] } },
        { label: "Website", type: "Text" },
        { label: "Contacts", type: "Int", formula: "len(Contacts.lookupRecords(Company=$id))" },
        { label: "Pipeline", type: "Numeric", formula: "SUM(Deals.lookupRecords(Company=$id).Value)", options: currency },
      ],
      rows: [
        ["Northwind Labs", "Software", "northwind.example"],
        ["Blue Harbor Retail", "Retail", "blueharbor.example"],
        ["Cedar Health", "Healthcare", "cedarhealth.example"],
        ["Atlas Finance", "Finance", "atlasfin.example"],
      ],
    },
    {
      name: "Contacts",
      columns: [
        { label: "Name", type: "Text" },
        { label: "Email", type: "Text" },
        { label: "Phone", type: "Text" },
        { label: "Company", type: "Ref", refTable: "Companies", visibleCol: "Name" },
        { label: "Role", type: "Text" },
      ],
      rows: [
        ["Maya Chen", "maya@northwind.example", "555-0101", { $ref: 0 }, "CTO"],
        ["Liam Patel", "liam@northwind.example", "555-0102", { $ref: 0 }, "Head of Ops"],
        ["Sofia Rossi", "sofia@blueharbor.example", "555-0103", { $ref: 1 }, "Buyer"],
        ["Noah Kim", "noah@cedarhealth.example", "555-0104", { $ref: 2 }, "IT Director"],
        ["Emma Novak", "emma@atlasfin.example", "555-0105", { $ref: 3 }, "CFO"],
      ],
    },
    {
      name: "Deals",
      columns: [
        { label: "Title", type: "Text" },
        { label: "Company", type: "Ref", refTable: "Companies", visibleCol: "Name" },
        { label: "Stage", type: "Choice", options: { choices: STAGES } },
        { label: "Value", type: "Numeric", options: currency },
        { label: "Close Date", type: "Date", options: { dateFormat: "MMM D, YYYY" } },
        {
          label: "Probability",
          type: "Numeric",
          formula: 'SWITCH($Stage, "Lead", 0.1, "Qualified", 0.3, "Proposal", 0.6, "Won", 1, 0)',
          options: { numMode: "percent", decimals: 0 },
        },
        { label: "Weighted", type: "Numeric", formula: "$Value * $Probability", options: currency },
      ],
      rows: [
        ["Platform license", { $ref: 0 }, "Proposal", 48000, "2026-12-15"],
        ["Support add-on", { $ref: 0 }, "Won", 9000, "2026-10-02"],
        ["POS rollout", { $ref: 1 }, "Qualified", 32000, "2027-01-20"],
        ["Patient portal", { $ref: 2 }, "Lead", 25000, "2027-02-28"],
        ["Risk dashboard", { $ref: 3 }, "Proposal", 56000, "2026-12-01"],
        ["Data migration", { $ref: 3 }, "Lost", 12000, "2026-09-30"],
      ],
    },
  ],
  pages: [
    {
      name: "Companies",
      widgets: [
        { type: "table", table: "Companies", title: "Companies", width: 7, height: 300 },
        { type: "card", table: "Companies", title: "Company", width: 5, height: 300, linkTo: 0 },
        { type: "table", table: "Contacts", title: "Contacts", width: 6, height: 280, linkTo: 0, linkCol: "Company" },
        { type: "table", table: "Deals", title: "Deals", width: 6, height: 280, linkTo: 0, linkCol: "Company" },
      ],
    },
    {
      name: "Pipeline",
      widgets: [
        { type: "summary", table: "Deals", title: "By stage", width: 5, height: 300, options: { groupByLabels: ["Stage"] } },
        { type: "chart", table: "Deals", title: "Value by stage", width: 7, height: 300, options: { chartType: "bar", xLabel: "Stage", yLabels: ["Value", "Weighted"], aggregate: "sum" } },
        { type: "table", table: "Deals", title: "Deals in stage", width: 12, height: 300, linkTo: 0 },
      ],
    },
    { name: "Contacts", widgets: [{ type: "table", table: "Contacts" }] },
    {
      name: "New contact form",
      widgets: [{ type: "form", table: "Contacts", title: "Contact us", options: { formDescription: "Leave your details and we'll be in touch." } }],
    },
  ],
};

const TASK_STATUS = ["To do", "In progress", "Blocked", "Done"];

const projects: DocSpec = {
  name: "Project Tracker",
  tables: [
    {
      name: "Projects",
      columns: [
        { label: "Project", type: "Text" },
        { label: "Owner", type: "Text" },
        { label: "Due", type: "Date" },
        { label: "Tasks", type: "Int", formula: "len(Tasks.lookupRecords(Project=$id))" },
        { label: "Done", type: "Int", formula: 'len(Tasks.lookupRecords(Project=$id, Status="Done"))' },
        { label: "Progress", type: "Numeric", formula: "$Done / $Tasks if $Tasks else 0", options: { numMode: "percent", decimals: 0 } },
      ],
      rows: [
        ["Website relaunch", "Ana", "2026-12-12"],
        ["Q1 marketing plan", "Ben", "2027-01-15"],
        ["Mobile app beta", "Chloe", "2027-02-01"],
      ],
    },
    {
      name: "Tasks",
      columns: [
        { label: "Task", type: "Text" },
        { label: "Project", type: "Ref", refTable: "Projects", visibleCol: "Project" },
        { label: "Assignee", type: "Text" },
        { label: "Status", type: "Choice", options: { choices: TASK_STATUS } },
        { label: "Due", type: "Date" },
        { label: "Overdue", type: "Bool", formula: '$Due and $Due < TODAY() and $Status != "Done"' },
        { label: "Estimate (h)", type: "Numeric" },
      ],
      rows: [
        ["Wireframes", { $ref: 0 }, "Ana", "Done", "2026-10-20", null, 12],
        ["Copywriting", { $ref: 0 }, "Dev", "In progress", "2026-11-10", null, 16],
        ["Build pages", { $ref: 0 }, "Ana", "To do", "2026-11-28", null, 40],
        ["Budget draft", { $ref: 1 }, "Ben", "Done", "2026-10-30", null, 6],
        ["Channel research", { $ref: 1 }, "Eli", "Blocked", "2026-11-05", null, 10],
        ["Beta signup page", { $ref: 2 }, "Chloe", "To do", "2026-12-01", null, 8],
        ["Crash reporting", { $ref: 2 }, "Dev", "In progress", "2026-11-20", null, 14],
      ],
    },
  ],
  pages: [
    {
      name: "Projects",
      widgets: [
        { type: "table", table: "Projects", title: "Projects", width: 12, height: 240 },
        { type: "table", table: "Tasks", title: "Tasks", width: 12, height: 320, linkTo: 0, linkCol: "Project" },
      ],
    },
    {
      name: "Status",
      widgets: [
        { type: "chart", table: "Tasks", title: "Tasks by status", width: 6, height: 320, options: { chartType: "pie", xLabel: "Status", yLabels: [], aggregate: "count" } },
        { type: "summary", table: "Tasks", title: "Hours by assignee", width: 6, height: 320, options: { groupByLabels: ["Assignee"] } },
      ],
    },
    { name: "All tasks", widgets: [{ type: "table", table: "Tasks" }] },
  ],
};

export const TEMPLATES: Template[] = [
  { id: "crm", name: "Lightweight CRM", description: "Companies, contacts and a deal pipeline with linked views and charts.", spec: crm },
  { id: "projects", name: "Project Tracker", description: "Projects with tasks, progress formulas and a status dashboard.", spec: projects },
];

export const BLANK_DOC: DocSpec = {
  name: "Untitled document",
  tables: [{ name: "Table1", columns: [{ label: "A", type: "Any" }, { label: "B", type: "Any" }, { label: "C", type: "Any" }], rows: [] }],
};
