export const convertSmithyTypeToCliType = (type, obj) => {
  const [namespace, target] = type.split("#");

  // Primitive Smithy types
  if (namespace === "smithy.api") {
    return { type: target.toLowerCase() }; // return as object
  }

  // Custom type defined in obj
  const typeDef = obj["shapes"][type];
  if (!typeDef) {
    throw new Error(`Type definition not found for ${type}`);
  }

  // Check if this is a streaming blob
  const isStreaming = typeDef.traits && typeDef.traits["smithy.api#streaming"];

  switch (typeDef.type) {
    case "blob":
      return {
        type: "blob",
        streaming: isStreaming || false,
      };

    case "enum":
      const enumValues = [];
      for (let [memberName, memberDef] of Object.entries(typeDef.members)) {
        const enumValue = memberDef.traits?.["smithy.api#enumValue"];
        enumValues.push({
          name: memberName,
          value: enumValue || memberName,
        });
      }
      return {
        type: "enum",
        values: enumValues,
      };

    case "list":
      return {
        type: "list",
        member: convertSmithyTypeToCliType(typeDef.member.target, obj),
      };

    case "map":
      return {
        type: "map",
        key: {
          name: "key",
          ...convertSmithyTypeToCliType(typeDef.key.target, obj),
          documentation: typeDef.key.traits?.["smithy.api#documentation"] || "",
        },
        value: {
          name: "value",
          ...convertSmithyTypeToCliType(typeDef.value.target, obj),
          documentation:
            typeDef.value.traits?.["smithy.api#documentation"] || "",
        },
      };

    case "structure":
      const members = {};
      for (let [memberName, memberDef] of Object.entries(typeDef.members)) {
        members[memberName] = {
          name: memberName,
          ...convertSmithyTypeToCliType(memberDef.target, obj),
          required: !!(
            memberDef.traits && memberDef.traits["smithy.api#required"]
          ),
          documentation: memberDef.traits
            ? memberDef.traits["smithy.api#documentation"] || ""
            : "",
          // Check for HTTP payload trait (used for streaming)
          httpPayload: !!(
            memberDef.traits && memberDef.traits["smithy.api#httpPayload"]
          ),
        };
      }
      return {
        type: "structure",
        members,
      };

    default:
      throw new Error(`Unsupported type: ${typeDef.type}`);
  }
};

export const generateCommandImports = (ops) => {
  let imports = [];
  for (let i = 0; i < ops.length; i++) {
    imports.push(ops[i].opName + "Command");
  }
  return imports.join(", ");
};

export const generateActionImports = (ops) => {
  let imports = [];
  for (let i = 0; i < ops.length; i++) {
    imports.push(ops[i].opName + "Action");
  }
  return imports.join(", ");
};

export const generateOptions = (params, isAuthReq) => {
  const paramOptions = params
    .map((param) => {
      const isList = param.type === "list";
      const isBlob = param.type === "blob";

      let typePlaceholder;
      if (isBlob) {
        typePlaceholder = param.streaming ? `<file>` : `<file>`;
      } else if (isList) {
        typePlaceholder = `<${param.name}...>`;
      } else {
        typePlaceholder = `<${param.name}>`;
      }

      const flag = `--${param.name} ${typePlaceholder}`;
      const desc = isBlob
        ? `${param.name} parameter (file path${
            param.streaming ? ", supports streaming" : ""
          })`
        : `${param.name} parameter`;

      if (param.type === "blob") {
        const parserFn = `(value) => {
  try {
    if (!fs.existsSync(value)) {
      throw new Error(\`File not found: \${value}\`);
    }
    return value; // Return path, will be processed later
  } catch (err) {
    throw new Error("--${param.name} must be a valid file path");
  }
}`;
        return ` .option("${flag}", "${desc}", ${parserFn})`;
      }

      if (param.type === "enum") {
        const allowedValues = param.values.map((v) => v.value).join(", ");
        const enumDesc = `${desc} (allowed values: ${allowedValues})`;
        const parserFn = `(value) => {
  const allowedValues = [${param.values.map((v) => `"${v.value}"`).join(", ")}];
  if (!allowedValues.includes(value)) {
    throw new Error("--${param.name} must be one of: ${allowedValues}");
  }
  return value;
}`;
        return ` .option("${flag}", "${enumDesc}", ${parserFn})`;
      }

      if (param.type === "document") {
        const parserFn = `(value) => {
  try {
    if (value.startsWith("@")) {
      return readJsonFile(value.slice(1));
    }
    return JSON.parse(value);
  } catch (err) {
    throw new Error("--${param.name} must be valid JSON or a @file.json path");
  }
}`;
        return ` .option("${flag}", "${desc}", ${parserFn})`;
      }
      if (param.type === "boolean") {
        const parserFn = `(value) => {
  if (value.toLowerCase() === 'true') return true;
  if (value.toLowerCase() === 'false') return false;
  throw new Error("--${param.name} must be true or false");
}`;
        return ` .option("${flag}", "${desc}", ${parserFn})`;
      }
      if (param.type === "integer") {
        const parserFn = `(value) => {
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    throw new Error("--${param.name} must be a valid integer");
  }
  return parsed;
}`;
        return ` .option("${flag}", "${desc}", ${parserFn})`;
      }

      return ` .option("${flag}", "${desc}")`;
    })
    .join("\n");

  const authOption = isAuthReq
    ? `\n .option("--token <token>", "Bearer token for authentication")`
    : "";
  return paramOptions + authOption;
};

export const generateParamDocs = (
  params,
  indent = 4,
  isTopLevel = true,
  isAuthReq,
) => {
  let paramDocs = "";
  const processParam = (param, currentIndent, topLevel) => {
    const req = param.required ? "(required)" : "(optional)";
    const linePrefix = topLevel ? "--" : "";
    const curSpace = " ".repeat(currentIndent);

    switch (param.type) {
      case "blob":
        const streamingNote = param.streaming ? " (streaming)" : "";
        paramDocs += `${curSpace}${linePrefix}${param.name} <file-path>${streamingNote} ${req}`;
        if (param.documentation) paramDocs += ` : ${param.documentation}`;
        paramDocs += "\n";
        break;

      case "enum":
        const enumValues = param.values.map((v) => v.value).join(" | ");
        paramDocs += `${curSpace}${linePrefix}${param.name} <${enumValues}> ${req}`;
        if (param.documentation) paramDocs += ` : ${param.documentation}`;
        paramDocs += "\n";
        break;

      case "structure":
        paramDocs += `${curSpace}${linePrefix}${param.name} ${req}`;
        if (param.documentation) paramDocs += ` : ${param.documentation}`;
        paramDocs += "\n";
        Object.values(param.members || {}).forEach((m) =>
          processParam(m, currentIndent + 4, false),
        );
        break;

      case "list":
        if (["structure", "list", "map", "blob"].includes(param.member.type)) {
          paramDocs += `${curSpace}${linePrefix}${param.name} ${req}`;
          if (param.documentation) paramDocs += ` : ${param.documentation}`;
          paramDocs += "\n";
          processParam(param.member, currentIndent + 4, false);
        } else {
          paramDocs += `${curSpace}${linePrefix}${
            param.name
          } [<${param.member.type.toLowerCase()}>] ${req}`;
          if (param.documentation) paramDocs += ` : ${param.documentation}`;
          paramDocs += "\n";
        }
        break;

      case "map":
        paramDocs += `${curSpace}${linePrefix}${param.name} ${req}`;
        if (param.documentation) paramDocs += ` : ${param.documentation}`;
        paramDocs += "\n";

        // key
        paramDocs += `${curSpace}    key <${param.key.type.toLowerCase()}>`;
        if (param.key.documentation)
          paramDocs += ` : ${param.key.documentation}`;
        paramDocs += "\n";

        // value
        if (["structure", "list", "map", "blob"].includes(param.value.type)) {
          paramDocs += `${curSpace}    value ${
            param.value.required ? "(required)" : "(optional)"
          }`;
          if (param.value.documentation)
            paramDocs += ` : ${param.value.documentation}`;
          paramDocs += "\n";
          processParam(param.value, currentIndent + 8, false);
        } else {
          paramDocs += `${curSpace}    value <${param.value.type.toLowerCase()}>`;
          if (param.value.documentation)
            paramDocs += ` : ${param.value.documentation}`;
          paramDocs += "\n";
        }
        break;

      default:
        paramDocs += `${curSpace}${linePrefix}${
          param.name
        } <${param.type.toLowerCase()}> ${req}`;
        if (param.documentation) paramDocs += ` : ${param.documentation}`;
        paramDocs += "\n";
        break;
    }
  };

  params.forEach((param) => processParam(param, indent, isTopLevel, false));

  if (isAuthReq) {
    const curSpace = " ".repeat(indent);
    const linePrefix = isTopLevel ? "--" : "";
    paramDocs += `${curSpace}${linePrefix}token <string> (required) : Bearer token for authentication\n`;
  }

  return paramDocs;
};

export const generateCliUsageExample = (
  actionName,
  params,
  commandPrefix,
  isAuthReq,
) => {
  const requiredParams = params.filter((param) => param.required);
  const optionalParams = params.filter((param) => !param.required);

  let example = `$ ${commandPrefix} ${actionName}`;

  // Add required parameters
  requiredParams.forEach((param) => {
    const isList = param.type.startsWith("[") && param.type.endsWith("]");
    const isBlob = param.type === "blob";

    let placeholder;
    if (isBlob) {
      placeholder = `<file-path>`;
    } else if (isList) {
      placeholder = `<${param.name}...>`;
    } else {
      placeholder = `<${param.name}>`;
    }

    example += ` \\\\\n     --${param.name} ${placeholder}`;
  });
  if (isAuthReq) {
    example += ` \\\\\n     --token <string>`;
  }

  // Add first optional parameter as example if exists
  if (optionalParams.length > 0) {
    const param = optionalParams[0];
    const isList = param.type.startsWith("[") && param.type.endsWith("]");
    const isBlob = param.type === "blob";

    let placeholder;
    if (isBlob) {
      placeholder = `<file-path>`;
    } else if (isList) {
      placeholder = `<${param.name}...>`;
    } else if (param.type === "document") {
      placeholder = `<json|@file.json>`;
    } else {
      placeholder = `<${param.name}>`;
    }

    example += ` \\\\\n     [--${param.name} ${placeholder}]`;
  }

  return example;
};

export const generateMixedUsageExample = (
  actionName,
  params,
  commandPrefix,
  isAuthReq,
) => {
  const someParams = params.slice(0, 2); // Take first 2 params as example
  let example = `$ ${commandPrefix} ${actionName} @params.json`;

  someParams.forEach((param) => {
    let placeholder;
    if (param.type === "blob") {
      placeholder = `<file-path>`;
    } else if (param.type === "document") {
      placeholder = `<json|@file.json>`;
    } else {
      placeholder = `<value>`;
    }
    example += ` --${param.name} ${placeholder}`;
  });
  if (isAuthReq) {
    example += ` --token <value>`;
  }

  return example;
};

export const generateJsonFileExample = (params, isAuthReq) => {
  const exampleObj = {};

  params.forEach((param) => {
    if (param.type === "blob") {
      exampleObj[param.name] = "./path/to/file.bin";
    } else if (param.type === "document") {
      exampleObj[param.name] = {
        example_key: "example_value",
        version: "1.0.0",
      };
    } else if (param.type === "integer") {
      exampleObj[param.name] = 123;
    } else if (param.type.startsWith("[") && param.type.endsWith("]")) {
      exampleObj[param.name] = ["item1", "item2"];
    } else {
      exampleObj[param.name] = `example_${param.name}`;
    }
  });

  if (isAuthReq) {
    exampleObj["token"] = "your_bearer_token_here";
  }

  return `JSON file format (params.json):
${JSON.stringify(exampleObj, null, 2)}`;
};

export const generateDocumentFieldHandling = (params) => {
  const documentFields = params.filter((param) => param.type === "document");

  if (documentFields.length === 0) return "";

  let handling = `// Handle document fields specially if they're objects from JSON\n`;

  documentFields.forEach((field) => {
    handling += `  if (finalOptions.${field.name} && typeof finalOptions.${field.name} === 'object') {
    // Convert object to string if command expects JSON string
    finalOptions.${field.name} = JSON.stringify(finalOptions.${field.name});
  }\n`;
  });

  return handling;
};
// Generic recursive function to process blob fields at any nesting level
export const processBlobFields = (obj, params, parentPath = "finalOptions") => {
  let processing = "";

  const processParam = (param, currentPath) => {
    const fieldPath = `${currentPath}.${param.name}`;

    switch (param.type) {
      case "blob":
        if (param.streaming) {
          processing += `  if (${fieldPath}) {
    // For streaming blobs, create a readable stream
    const filePath${param.name} = path.resolve(${fieldPath});
    if (!fs.existsSync(filePath${param.name})) {
      throw new Error(\`File not found: \${filePath${param.name}}\`);
    }
    ${fieldPath} = fs.createReadStream(filePath${param.name});
  }\n`;
        } else {
          processing += `  if (${fieldPath}) {
    // For regular blobs, read file content
    const filePath${param.name} = path.resolve(${fieldPath});
    if (!fs.existsSync(filePath${param.name})) {
      throw new Error(\`File not found: \${filePath${param.name}}\`);
    }
    ${fieldPath} = fs.readFileSync(filePath${param.name});
  }\n`;
        }
        break;

      case "structure":
        if (param.members) {
          processing += `  if (${fieldPath}) {\n`;
          Object.values(param.members).forEach((member) => {
            processParam(member, fieldPath);
          });
          processing += `  }\n`;
        }
        break;

      case "list":
        if (param.member && hasNestedBlob(param.member)) {
          processing += `  if (Array.isArray(${fieldPath})) {
    ${fieldPath}.forEach((item, index) => {\n`;

          if (param.member.type === "blob") {
            if (param.member.streaming) {
              processing += `      if (item) {
        const filePath = path.resolve(item);
        if (!fs.existsSync(filePath)) {
          throw new Error(\`File not found: \${filePath}\`);
        }
        ${fieldPath}[index] = fs.createReadStream(filePath);
      }\n`;
            } else {
              processing += `      if (item) {
        const filePath = path.resolve(item);
        if (!fs.existsSync(filePath)) {
          throw new Error(\`File not found: \${filePath}\`);
        }
        ${fieldPath}[index] = fs.readFileSync(filePath);
      }\n`;
            }
          } else if (
            param.member.type === "structure" &&
            param.member.members
          ) {
            Object.values(param.member.members).forEach((member) => {
              processParam(member, `${fieldPath}[index]`);
            });
          }
          processing += `    });
  }\n`;
        }
        break;

      case "map":
        if (param.value && hasNestedBlob(param.value)) {
          processing += `  if (${fieldPath} && typeof ${fieldPath} === 'object') {
    Object.keys(${fieldPath}).forEach(key => {\n`;

          if (param.value.type === "blob") {
            if (param.value.streaming) {
              processing += `      if (${fieldPath}[key]) {
        const filePath = path.resolve(${fieldPath}[key]);
        if (!fs.existsSync(filePath)) {
          throw new Error(\`File not found: \${filePath}\`);
        }
        ${fieldPath}[key] = fs.createReadStream(filePath);
      }\n`;
            } else {
              processing += `      if (${fieldPath}[key]) {
        const filePath = path.resolve(${fieldPath}[key]);
        if (!fs.existsSync(filePath)) {
          throw new Error(\`File not found: \${filePath}\`);
        }
        ${fieldPath}[key] = fs.readFileSync(filePath);
      }\n`;
            }
          } else if (param.value.type === "structure" && param.value.members) {
            Object.values(param.value.members).forEach((member) => {
              processParam(member, `${fieldPath}[key]`);
            });
          }
          processing += `    });
  }\n`;
        }
        break;
    }
  };

  params.forEach((param) => processParam(param, parentPath));

  return processing;
};

// Updated generateBlobFieldHandling function (now generic and recursive)
export const generateBlobFieldHandling = (params) => {
  // Check if there are any blob fields at any level
  const hasAnyBlobs = params.some((param) => hasNestedBlob(param));

  if (!hasAnyBlobs) return "";

  let handling = `// Handle blob fields recursively at all levels\n`;
  handling += processBlobFields(null, params);

  return handling;
};

// Enhanced helper function to check for nested blob types (already exists but ensuring it's complete)
const hasNestedBlob = (param) => {
  if (param.type === "blob") return true;
  if (param.type === "structure" && param.members) {
    return Object.values(param.members).some((member) => hasNestedBlob(member));
  }
  if (param.type === "list" && param.member) {
    return hasNestedBlob(param.member);
  }
  if (param.type === "map" && param.value) {
    return hasNestedBlob(param.value);
  }
  return false;
};

export const getRequiredParamsList = (params, parentKey = "", isAuthReq) => {
  let required = [];

  params.forEach((param) => {
    const fullName = parentKey ? `${parentKey}.${param.name}` : param.name;

    if (param.required) {
      required.push(fullName);
    }

    if (param.type === "structure" && param.members) {
      required = required.concat(
        getRequiredParamsList(Object.values(param.members), fullName),
      );
    } else if (param.type === "list" && param.member) {
      // Recurse into the member, whatever type it is
      required = required.concat(
        getRequiredParamsList([param.member], `${fullName}[]`),
      );
    } else if (param.type === "map" && param.value) {
      // Recurse into the map value, whatever type it is
      required = required.concat(
        getRequiredParamsList([param.value], `${fullName}{value}`),
      );
    }
  });
  if (isAuthReq) {
    required.push("token");
  }

  return required;
};

export const isAuthAPI = (traits) => {
  return (
    Array.isArray(traits["smithy.api#auth"]) &&
    traits["smithy.api#auth"].length === 0
  );
};

export const isAuthRequired = (service) => {
  return Boolean(service.traits && service.traits["smithy.api#httpBearerAuth"]);
};
