import fs from "node:fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import mustache from "mustache";
import {
  convertSmithyTypeToCliType,
  generateCommandImports,
  generateOptions,
  generateParamDocs,
  generateCliUsageExample,
  generateMixedUsageExample,
  generateJsonFileExample,
  generateDocumentFieldHandling,
  getRequiredParamsList,
  isAuthAPI,
  isAuthRequired,
  generateBlobFieldHandling,
  generateActionImports,
} from "./utils.js";

export async function startBuilder(
  namespace,
  service,
  modelsJSON,
  clientPath,
  nModule,
  nModuleVersion,
  buildPath,
  cliName,
  cliDescription
) {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  const servicePath = `${namespace}#${service}`;
  const serviceName = servicePath.split("#")[1];

  var obj;

  let data = await fs.readFile(modelsJSON, { encoding: "utf8" });

  await (async (err, data) => {
    if (err) throw err;
    obj = JSON.parse(data);
    let operations = obj["shapes"][`${namespace}#${service}`]["operations"];
    operations = operations.map((val) => val.target);
    // console.log(operations)

    let isAuthReq = isAuthRequired(obj["shapes"][`${namespace}#${service}`]);

    let commands = [];

    for (let i = 0; i < operations.length; i++) {
      let op = operations[i];
      let opBody = obj["shapes"][op];
      let opInputTarget = opBody["input"]["target"];
      let opOutputTarget = opBody["output"]["target"];
      let opInputTargetName = opBody["input"]["target"].split("#")[1];
      let opOutputTargetName = opBody["output"]["target"].split("#")[1];

      let opInputShape = obj["shapes"][opInputTarget];
      let opOutputShape = obj["shapes"][opOutputTarget];
      // console.log("g",opInputShape)
      // if(i == 1) console.log(opBody)

      let cliOperation = {};

      cliOperation.opName = op.split("#")[1];
      cliOperation.name = opBody["traits"]["smithy.api#http"]["uri"];
      cliOperation.uri = opBody["traits"]["smithy.api#http"]["uri"];
      cliOperation.description = opBody["traits"]["smithy.api#documentation"];
      cliOperation.opInputTargetName = opInputTargetName;
      cliOperation.opOutputTargetName = opOutputTargetName;
      cliOperation.traits = opBody["traits"];

      cliOperation.inputs = [];
      cliOperation.outputs = [];

      if (opInputShape) {
        for (let [key, value] of Object.entries(opInputShape.members)) {
          cliOperation.inputs.push({
            name: key,
            ...convertSmithyTypeToCliType(value.target, obj),
            required: !!(value.traits && value.traits["smithy.api#required"]),
            documentation: value.traits
              ? value.traits["smithy.api#documentation"]
              : "",
          });
        }
      }

      if (opOutputShape) {
        for (let [key, value] of Object.entries(opOutputShape.members)) {
          cliOperation.outputs.push({
            name: key,
            ...convertSmithyTypeToCliType(value.target, obj),
            required: !!(value.traits && value.traits["smithy.api#required"]),
            documentation: value.traits
              ? value.traits["smithy.api#documentation"]
              : "",
          });
        }
      }

      commands.push(cliOperation);
    }

    const projectDir = buildPath;
    const packageJsonFilePath = path.join(projectDir, "package.json");
    const indexFilePath = path.join(projectDir, "index.js");

    await fs.mkdir(projectDir, { recursive: true });
    const templatePath = path.join(__dirname, "templates");
    const templatePackage = await fs.readFile(
      path.join(templatePath, "package.json.tmpl"),
      {
        encoding: "utf8",
      }
    );

    const outputPackage = mustache.render(templatePackage, {
      clientLocation: clientPath,
      cliName: cliName,
      package: nModule,
      packageVersion: nModuleVersion,
    });
    console.log("Writing package.json");
    await fs.writeFile(packageJsonFilePath, outputPackage, "utf-8");
    console.log("Generated package.json");

    await fs.mkdir(projectDir, { recursive: true });

    let codeBlocks = [];
    let actionBlocks = [];

    const commandImports = generateCommandImports(commands);
    const actionImports = generateActionImports(commands);

    const actionHeaderTemplate = await fs.readFile(
      path.join(templatePath, "action-header.js.tmpl"),
      {
        encoding: "utf8",
      }
    );

    const actionHeader = mustache.render(actionHeaderTemplate, {
      service: service,
      imports: commandImports,
      importFrom: nModule,
      client: serviceName + "Client",
    });

    actionBlocks.push(actionHeader);

    const templateHeader = await fs.readFile(
      path.join(templatePath, "header.js.tmpl"),
      {
        encoding: "utf8",
      }
    );
    const outputHeader = mustache.render(templateHeader, {
      actions: actionImports,
      service: service,
      cliName: cliName,
      cliDescription: cliDescription,
      cliVersion: nModuleVersion,
    });

    codeBlocks.push(outputHeader);

    for (let i = 0; i < commands.length; i++) {
      const templateCommand = await fs.readFile(
        path.join(templatePath, "/command.js.tmpl"),
        {
          encoding: "utf8",
        }
      );
      const actionTemplate = await fs.readFile(
        path.join(templatePath, "/action.js.tmpl"),
        {
          encoding: "utf8",
        }
      );

      const outputCommand = mustache.render(templateCommand, {
        actionName: commands[i].opName,
        actionDocumentation: " " + commands[i].description,
        paramDocs: generateParamDocs(
          commands[i].inputs,
          4,
          true,
          isAuthReq && !isAuthAPI(commands[i].traits)
        ),
        options: generateOptions(
          commands[i].inputs,
          isAuthReq && !isAuthAPI(commands[i].traits)
        ),
        commandPrefix: cliName, // Make this configurable
        cliUsageExample: generateCliUsageExample(
          commands[i].opName,
          commands[i].inputs,
          cliName,
          isAuthReq && !isAuthAPI(commands[i].traits)
        ),
        mixedUsageExample: generateMixedUsageExample(
          commands[i].opName,
          commands[i].inputs,
          cliName,
          isAuthReq && !isAuthAPI(commands[i].traits)
        ),
        jsonFileExample: generateJsonFileExample(
          commands[i].inputs,
          isAuthReq && !isAuthAPI(commands[i].traits)
        ),
      });

      const commandAction = mustache.render(actionTemplate, {
        cmd: commands[i].opName + "Command",
        functionName: commands[i].opName + "Action",
        requiredParamsList: JSON.stringify(
          getRequiredParamsList(
            commands[i].inputs,
            "",
            isAuthReq && !isAuthAPI(commands[i].traits)
          )
        ),
        blobFileHandling: generateBlobFieldHandling(commands[i].inputs),
        client: function (text, render) {
          if (isAuthReq && !isAuthAPI(commands[i].traits)) {
            return `const client = await getClient(finalOptions.token, true);`;
          } else {
            return `const client = await getClient(null, false);`;
          }
        },
        documentFieldHandling: generateDocumentFieldHandling(
          commands[i].inputs
        ),
      });
      actionBlocks.push(commandAction);

      codeBlocks.push(outputCommand);
    }

    //footer
    const templateFooter = await fs.readFile(
      path.join(templatePath, "footer.js.tmpl"),
      {
        encoding: "utf8",
      }
    );
    const outputFooter = mustache.render(templateFooter, {
      cliName: cliName,
    });

    codeBlocks.push(outputFooter);
    const templateBin = await fs.readFile(
      path.join(templatePath, "bin.js.tmpl"),
      {
        encoding: "utf8",
      }
    );
    const outputBin = mustache.render(templateBin, {});
    await fs.writeFile(path.join(projectDir, "bin.js"), outputBin, "utf-8");

    await fs.writeFile(
      path.join(projectDir, "action.js"),
      actionBlocks.join("\n"),
      "utf-8"
    );

    console.log("Writing index.js");
    await fs.writeFile(indexFilePath, codeBlocks.join("\n\n"), "utf-8");
    console.log("Generated index.js");

    // console.log(commands)
  })(null, data);
}
