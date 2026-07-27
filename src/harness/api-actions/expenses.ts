import { defineRiskyAction, type ActionDefinition } from "../action.js";
import { durableMutationContract } from "../durable-mutation-contract.js";
import {
  commitDeleteArchivedExpenseCategory,
  commitExpenseCategoryRename,
  commitExpenseCategoryStatusUpdate,
  EXPENSE_CATEGORY_ARCHIVED_LITERAL_ALIASES,
  expenseCategoryRenameSchema,
  expenseCategoryStatusUpdateSchema,
  expenseCategoryTargetRefSchema,
  previewDeleteArchivedExpenseCategory,
  previewExpenseCategoryRename,
  previewExpenseCategoryStatusUpdate,
} from "../workflows/expense-action-shared.js";
import type { ApiActionMetadataCarrier, ApiAccess, ApiMethod, AvailabilityByAuthClass, MaterialFieldMetadata } from "../api-operation.js";

const EXP = "expenses" as const;

const EXPENSE_AVAILABILITY: AvailabilityByAuthClass = Object.freeze({
  addon: Object.freeze({ available: true }),
  api_key: Object.freeze({ available: true }),
});

function expenseEndpointKey(access: ApiAccess, method: ApiMethod, path: string, sourceModule = "expenses.ts"): string {
  return [access, "api", method, path, sourceModule].join("\0");
}

function expenseMaterialField(path: string, label: string, formatterId: string, requiredInPreview: boolean): MaterialFieldMetadata {
  return Object.freeze({ kind: "value", path, label, formatterId, formatterVersion: 1, requiredInPreview });
}

function expenseApiMetadata(input: {
  actionName: string;
  operationId: string;
  method: ApiMethod;
  path: string;
  access: ApiAccess;
  primary: string;
  support: readonly string[];
  materialFields: readonly MaterialFieldMetadata[];
}): ApiActionMetadataCarrier {
  return Object.freeze({
    apiExposure: "api",
    apiOperation: Object.freeze({
      operationId: input.operationId,
      host: "api",
      method: input.method,
      path: input.path,
      access: input.access,
      exposure: "api",
    }),
    adapterEndpoints: Object.freeze({ primary: Object.freeze([input.primary]), support: Object.freeze([...input.support]) }),
    availabilityByAuthClass: EXPENSE_AVAILABILITY,
    boundedArgumentDictionaries: Object.freeze([]),
    materialFields: Object.freeze([...input.materialFields]),
    presentation: Object.freeze({ presenterId: input.actionName, version: 1 }),
  });
}

const expenseEndpoint = Object.freeze({
  categoriesList: expenseEndpointKey("read", "GET", "/workspaces/{workspaceId}/expenses/categories"),
  categoriesUpdate: expenseEndpointKey("write", "PUT", "/workspaces/{workspaceId}/expenses/categories/{id}"),
  categoriesStatus: expenseEndpointKey("write", "PATCH", "/workspaces/{workspaceId}/expenses/categories/{id}/status"),
  categoriesDelete: expenseEndpointKey("write", "DELETE", "/workspaces/{workspaceId}/expenses/categories/{id}"),
});

export const EXPENSE_CATEGORY_API_METADATA = Object.freeze({
  clockify_expenses_categories_rename: expenseApiMetadata({
    actionName: "clockify_expenses_categories_rename",
    operationId: "updateCategory",
    method: "PUT",
    path: "/workspaces/{workspaceId}/expenses/categories/{id}",
    access: "write",
    primary: expenseEndpoint.categoriesUpdate,
    support: [expenseEndpoint.categoriesList],
    materialFields: [
      expenseMaterialField("/id", "Category", "entity", true),
      expenseMaterialField("/name", "Category name", "text", true),
    ],
  }),
  clockify_expenses_categories_status_update: expenseApiMetadata({
    actionName: "clockify_expenses_categories_status_update",
    operationId: "updateExpenseCategoryStatus",
    method: "PATCH",
    path: "/workspaces/{workspaceId}/expenses/categories/{id}/status",
    access: "write",
    primary: expenseEndpoint.categoriesStatus,
    support: [expenseEndpoint.categoriesList],
    materialFields: [
      expenseMaterialField("/id", "Category", "entity", true),
      expenseMaterialField("/archived", "Archived", "boolean", true),
    ],
  }),
  clockify_expenses_categories_delete_archived: expenseApiMetadata({
    actionName: "clockify_expenses_categories_delete_archived",
    operationId: "deleteCategory",
    method: "DELETE",
    path: "/workspaces/{workspaceId}/expenses/categories/{id}",
    access: "write",
    primary: expenseEndpoint.categoriesDelete,
    support: [expenseEndpoint.categoriesList],
    materialFields: [
      expenseMaterialField("/id", "Category", "entity", true),
      expenseMaterialField("/name", "Category name", "text", false),
    ],
  }),
});

const targetContract = (strategies: ["update" | "delete" | "state-command", ...Array<"update" | "delete" | "state-command">]) =>
  durableMutationContract({ source: "confirmed", targeting: { mode: "snapshots", relations: ["target"] }, strategies });

const rename = defineRiskyAction({
  name: "clockify_expenses_categories_rename",
  ...EXPENSE_CATEGORY_API_METADATA.clockify_expenses_categories_rename,
  description:
    "Rename an expense category with one name PUT. Status changes use clockify_expenses_categories_status_update. Billing action — previews and requires confirmation.",
  group: EXP,
  risks: ["billing"],
  mutationWorkflow: "durable",
  mutationContract: targetContract(["update"]),
  schema: expenseCategoryRenameSchema,
  preview: (ctx, args) => previewExpenseCategoryRename(ctx, args),
  commit: (ctx, payload, operation) => commitExpenseCategoryRename(ctx, payload, operation, "clockify_expenses_categories_rename"),
});

const statusUpdate = defineRiskyAction({
  name: "clockify_expenses_categories_status_update",
  ...EXPENSE_CATEGORY_API_METADATA.clockify_expenses_categories_status_update,
  description:
    "Archive or unarchive an expense category with one status PATCH. Renames use clockify_expenses_categories_rename. Billing action — previews and requires confirmation.",
  group: EXP,
  risks: ["billing"],
  mutationWorkflow: "durable",
  mutationContract: targetContract(["state-command"]),
  semanticLiteralAliases: EXPENSE_CATEGORY_ARCHIVED_LITERAL_ALIASES,
  schema: expenseCategoryStatusUpdateSchema,
  preview: (ctx, args) => previewExpenseCategoryStatusUpdate(ctx, args),
  commit: (ctx, payload, operation) => commitExpenseCategoryStatusUpdate(ctx, payload, operation, "clockify_expenses_categories_status_update"),
});

const deleteArchived = defineRiskyAction({
  name: "clockify_expenses_categories_delete_archived",
  ...EXPENSE_CATEGORY_API_METADATA.clockify_expenses_categories_delete_archived,
  description:
    "Delete an already-archived expense category with a single DELETE (Clockify rejects deleting an active category). Pass the category id or its exact name. Destructive billing action — previews and requires confirmation.",
  group: EXP,
  risks: ["destructive", "billing"],
  mutationWorkflow: "durable",
  mutationContract: targetContract(["delete"]),
  schema: expenseCategoryTargetRefSchema,
  preview: (ctx, args) => previewDeleteArchivedExpenseCategory(ctx, args),
  commit: (ctx, payload, operation) => commitDeleteArchivedExpenseCategory(ctx, payload, operation, "clockify_expenses_categories_delete_archived"),
});

export const EXPENSE_API_ACTIONS: ActionDefinition[] = [
  rename,
  statusUpdate,
  deleteArchived,
];
