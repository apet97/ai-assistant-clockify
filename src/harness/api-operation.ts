export type ApiHost = "api" | "reports" | "audit";
export type ApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type ApiAccess = "read" | "write";
export type ApiExposure = "api" | "composite" | "generic" | "local";

export interface ApiOperationMetadata {
  operationId: string;
  host: ApiHost;
  method: ApiMethod;
  path: string;
  access: ApiAccess;
  exposure: ApiExposure;
}

export type AuthClass = "addon" | "api_key";
export type AvailabilityReason =
  | "unsupported_auth_class"
  | "unavailable_endpoint"
  | "official_operation_id_missing";

export type ApiAvailability =
  | { available: true; reason?: never }
  | { available: false; reason: AvailabilityReason };

export interface AvailabilityByAuthClass {
  addon: ApiAvailability;
  api_key: ApiAvailability;
}

export interface AdapterEndpointBinding {
  primary: readonly string[];
  support: readonly string[];
}

export interface BoundedDictionaryMetadata {
  path: string;
  keyPattern: string;
  maxKeyUtf8Bytes: number;
  maxEntries: number;
  valueSchemaFingerprint: string;
}

export type MaterialFieldMetadata =
  | {
      kind: "value";
      path: string;
      label: string;
      formatterId: string;
      formatterVersion: number;
      requiredInPreview: boolean;
    }
  | {
      kind: "array_item";
      containerPath: string;
      itemPath: string;
      labelTemplate: string;
      maxItems: number;
      formatterId: string;
      formatterVersion: number;
      requiredInPreview: boolean;
    }
  | {
      kind: "dictionary_entry";
      containerPath: string;
      valuePath: string;
      labelTemplate: string;
      maxEntries: number;
      formatterId: string;
      formatterVersion: number;
      requiredInPreview: boolean;
    };

export type MaterialScalarType = "string" | "number" | "boolean" | "null";

export type NormalizedOperationMaterialContractEntry =
  | {
      kind: "value";
      path: string;
      scalarType: MaterialScalarType;
    }
  | {
      kind: "array_item";
      containerPath: string;
      itemPath: string;
      maxItems: number;
      scalarType: MaterialScalarType;
    }
  | {
      kind: "dictionary_entry";
      containerPath: string;
      valuePath: string;
      maxEntries: number;
      scalarType: MaterialScalarType;
    };

export interface ActionPresentationMetadata {
  presenterId: string;
  version: number;
}

/** Metadata supplied by every raw action definition before registry validation. */
export interface ApiActionMetadataCarrier {
  apiExposure: ApiExposure;
  apiExposureReason?: string;
  apiOperation?: ApiOperationMetadata;
  adapterEndpoints?: AdapterEndpointBinding;
  availabilityByAuthClass: AvailabilityByAuthClass;
  boundedArgumentDictionaries?: readonly BoundedDictionaryMetadata[];
  materialFields?: readonly MaterialFieldMetadata[];
  normalizedOperationMaterialContract?: readonly NormalizedOperationMaterialContractEntry[];
  presentation?: ActionPresentationMetadata;
}

export type ActionRegistryId = "v1-internal" | "v2-api" | "v2-local";

export function materialScalarTypeForFormatter(formatterId: string): MaterialScalarType {
  switch (formatterId) {
    case "text":
    case "entity":
      return "string";
    case "number":
    case "money-minor":
      return "number";
    case "boolean":
      return "boolean";
    default:
      throw new Error(`unknown_material_formatter:${formatterId}`);
  }
}

export function normalizedOperationMaterialContractFor(
  fields: readonly MaterialFieldMetadata[],
): readonly NormalizedOperationMaterialContractEntry[] {
  return Object.freeze(fields.map((field): NormalizedOperationMaterialContractEntry => {
    const scalarType = materialScalarTypeForFormatter(field.formatterId);
    switch (field.kind) {
      case "value":
        return Object.freeze({ kind: field.kind, path: field.path, scalarType });
      case "array_item":
        return Object.freeze({
          kind: field.kind,
          containerPath: field.containerPath,
          itemPath: field.itemPath,
          maxItems: field.maxItems,
          scalarType,
        });
      case "dictionary_entry":
        return Object.freeze({
          kind: field.kind,
          containerPath: field.containerPath,
          valuePath: field.valuePath,
          maxEntries: field.maxEntries,
          scalarType,
        });
    }
  }));
}

/** Copy required metadata and only explicitly supplied exposure-specific fields. */
export function apiActionMetadataFields(
  source: ApiActionMetadataCarrier,
): ApiActionMetadataCarrier {
  const normalizedOperationMaterialContract =
    source.normalizedOperationMaterialContract
    ?? (source.apiExposure === "api"
      && source.apiOperation?.access === "write"
      && source.materialFields
      ? normalizedOperationMaterialContractFor(source.materialFields)
      : undefined);
  return {
    apiExposure: source.apiExposure,
    availabilityByAuthClass: source.availabilityByAuthClass,
    ...(source.apiExposureReason === undefined
      ? {}
      : { apiExposureReason: source.apiExposureReason }),
    ...(source.apiOperation === undefined ? {} : { apiOperation: source.apiOperation }),
    ...(source.adapterEndpoints === undefined
      ? {}
      : { adapterEndpoints: source.adapterEndpoints }),
    ...(source.boundedArgumentDictionaries === undefined
      ? {}
      : { boundedArgumentDictionaries: source.boundedArgumentDictionaries }),
    ...(source.materialFields === undefined ? {} : { materialFields: source.materialFields }),
    ...(normalizedOperationMaterialContract === undefined
      ? {}
      : { normalizedOperationMaterialContract }),
    ...(source.presentation === undefined ? {} : { presentation: source.presentation }),
  };
}
