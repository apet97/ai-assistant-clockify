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
  presentation?: ActionPresentationMetadata;
}

export type ActionRegistryId = "v1-internal" | "v2-api" | "v2-local";

/** Copy required metadata and only explicitly supplied exposure-specific fields. */
export function apiActionMetadataFields(
  source: ApiActionMetadataCarrier,
): ApiActionMetadataCarrier {
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
    ...(source.presentation === undefined ? {} : { presentation: source.presentation }),
  };
}
