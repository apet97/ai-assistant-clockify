/**
 * Re-export barrel for the per-area {@link WorkspaceClient} port slices. Each
 * slice lives in its own file and is composed into `WorkspaceClient` via
 * interface extension (`client.ts`). New phases add their port file here.
 */
export type { TimeEntryPort } from "./time-entries.js";
export type { ProjectPort } from "./projects.js";
export type { TaskPort } from "./tasks.js";
export type { ClientPort } from "./clients.js";
export type { TagPort } from "./tags.js";
export type { InvoicePort } from "./invoices.js";
export type { ExpensePort } from "./expenses.js";
export type { CustomFieldPort } from "./custom-fields.js";
export type { TimeOffPort } from "./time-off.js";
export type { HolidayPort } from "./holidays.js";
export type { UserPort } from "./users.js";
export type { WebhookPort } from "./webhooks.js";
export type { MiscRiskyPort } from "./misc-risky.js";
