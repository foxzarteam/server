/**
 * Split NestJS mono-files (dto + service + controller + thin module).
 * Re-exports Service from module for optional BC; prefer importing from .service.
 */
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "src");

const TARGETS = [
  "users",
  "otp",
  "customer",
  "partner",
  "chat",
  "contact",
  "services",
  "payment-accounts",
  "auth",
  "banners",
  "wallet",
  "admin",
];

function stripNestControllerImports(importHeader) {
  const drop = new Set([
    "Body",
    "Controller",
    "Delete",
    "Get",
    "Headers",
    "HttpCode",
    "HttpStatus",
    "Param",
    "Patch",
    "Post",
    "Put",
    "Res",
    "Module",
    "Query",
    "Req",
    "UseGuards",
  ]);
  // leave service-side imports as-is (slight unused is ok; noUnusedLocals off)
  return importHeader;
}

function extractModuleBlock(lines, modIdx) {
  return lines.slice(modIdx).join("\n").trimEnd() + "\n";
}

function rewriteModuleFile(moduleBlock, {
  base,
  ServiceName,
  ControllerName,
  ModuleName,
  hasDtos,
}) {
  // Parse imports/providers from existing block when possible.
  const importsMatch = moduleBlock.match(/imports:\s*\[([^\]]*)\]/);
  const controllersMatch = moduleBlock.match(/controllers:\s*\[([^\]]*)\]/);
  const providersMatch = moduleBlock.match(/providers:\s*\[([^\]]*)\]/);
  const exportsMatch = moduleBlock.match(/exports:\s*\[([^\]]*)\]/);

  const nestImports = (importsMatch?.[1] || "").trim();
  const providers = (providersMatch?.[1] || ServiceName).trim();
  const exportsList = (exportsMatch?.[1] || ServiceName).trim();

  // Build import lines for sibling files
  const localImports = [
    `import { ${ControllerName} } from './${base}.controller';`,
    `import { ${ServiceName} } from './${base}.service';`,
  ];

  // Extract relative imports that were in original for OtpModule etc from providers deps
  // Keep only Module-related paths from original file header — handled by caller.
  return { nestImports, providers, exportsList, localImports };
}

function splitFile(dirName) {
  const dir = path.join(SRC, dirName);
  const base = dirName; // payment-accounts
  const modulePath = path.join(dir, `${base}.module.ts`);
  if (!fs.existsSync(modulePath)) {
    throw new Error(`Missing ${modulePath}`);
  }
  const content = fs.readFileSync(modulePath, "utf8");
  const lines = content.split(/\r?\n/);

  const injIdx = lines.findIndex((l) => l.startsWith("@Injectable()"));
  const ctrlIdx = lines.findIndex((l) => l.startsWith("@Controller("));
  const modIdx = lines.findIndex((l) => l.startsWith("@Module("));
  if (injIdx < 0 || ctrlIdx < 0 || modIdx < 0) {
    throw new Error(`${dirName}: markers not found inj=${injIdx} ctrl=${ctrlIdx} mod=${modIdx}`);
  }

  // Find end of import section: first line after imports that starts class or @Injectable or const/type that isn't import
  let firstBody = 0;
  for (let i = 0; i < injIdx; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    if (t.startsWith("import ") || t.startsWith("} from") || t.startsWith("from ")) continue;
    // multi-line import interior
    if (/^[\w{},\s'"./]+$/.test(t) && i > 0 && lines[i - 1].includes("import")) continue;
    if (t.startsWith("import{")) continue;
    // class-validator etc fully in import
    if (!t.startsWith("class ") && !t.startsWith("export ") && !t.startsWith("@") && !t.startsWith("type ") && !t.startsWith("interface ") && !t.startsWith("const ") && !t.startsWith("function ") && !t.startsWith("/**") && !t.startsWith("*") && !t.startsWith("//")) {
      // might still be import continuation
      if (t.includes(" from ") || t.endsWith(",") || t === "}" || t.startsWith("{")) continue;
    }
    if (t.startsWith("class ") || t.startsWith("export class") || t.startsWith("@Injectable") || t.startsWith("/**") || t.startsWith("//") || t.startsWith("type ") || t.startsWith("interface ") || t.startsWith("const ") || t.startsWith("function ") || t.startsWith("export type") || t.startsWith("export interface") || t.startsWith("export const") || t.startsWith("export function")) {
      firstBody = i;
      break;
    }
  }
  // Fallback: line before first class
  if (firstBody === 0) {
    for (let i = 0; i < injIdx; i++) {
      if (/^(export\s+)?class\s+/.test(lines[i].trim()) || lines[i].trim().startsWith("/**")) {
        firstBody = i;
        break;
      }
    }
  }

  const importLines = lines.slice(0, firstBody);
  let dtoLines = lines.slice(firstBody, injIdx);
  const serviceLines = lines.slice(injIdx, ctrlIdx);
  const controllerLines = lines.slice(ctrlIdx, modIdx);
  const moduleLines = lines.slice(modIdx);

  // Export DTO classes
  dtoLines = dtoLines.map((l) => {
    if (/^class\s+\w+/.test(l.trim()) && !l.trim().startsWith("export ")) {
      return l.replace(/^(\s*)class\s+/, "$1export class ");
    }
    return l;
  });

  const ServiceName = serviceLines.join("\n").match(/export class (\w+)/)?.[1]
    || serviceLines.join("\n").match(/class (\w+)/)?.[1];
  const ControllerName = controllerLines.join("\n").match(/export class (\w+)/)?.[1]
    || controllerLines.join("\n").match(/class (\w+)/)?.[1];
  const ModuleName = moduleLines.join("\n").match(/export class (\w+)/)?.[1];

  if (!ServiceName || !ControllerName || !ModuleName) {
    throw new Error(`${dirName}: names Service=${ServiceName} Ctrl=${ControllerName} Mod=${ModuleName}`);
  }

  // Ensure export on service/controller classes
  let serviceBody = serviceLines.join("\n");
  serviceBody = serviceBody.replace(/^class\s+(\w+)/m, "export class $1");
  if (!/^export class/m.test(serviceBody)) {
    serviceBody = serviceBody.replace(/^@Injectable\(\)\s*\nclass\s+/m, "@Injectable()\nexport class ");
  }

  let controllerBody = controllerLines.join("\n");
  controllerBody = controllerBody.replace(/^class\s+(\w+)/m, "export class $1");
  if (!/^export class/m.test(controllerBody)) {
    controllerBody = controllerBody.replace(/^@Controller\([^)]*\)\s*\nclass\s+/m, (m) => m.replace("class ", "export class "));
  }

  const hasDtos = dtoLines.some((l) => /export class \w+/.test(l) || /class \w+/.test(l));
  const dtoSymbols = [];
  for (const l of dtoLines) {
    const m = l.match(/export class (\w+)/);
    if (m) dtoSymbols.push(m[1]);
  }

  // Clean import header: remove Module from nest if present
  let importHeader = importLines.join("\n").trimEnd();
  importHeader = importHeader
    .replace(/,\s*Module\b/g, "")
    .replace(/\bModule\s*,\s*/g, "")
    .replace(/\{\s*Module\s*\}/g, "{}");

  // Detect external module imports from original for thin module
  const otpImport = /OtpModule/.test(content);
  const usersImport = /UsersModule/.test(content) && dirName !== "users";
  const leadsImport = /LeadsModule/.test(content);

  const externalModuleImports = [];
  if (otpImport) externalModuleImports.push(`import { OtpModule } from '../otp/otp.module';`);
  if (usersImport) externalModuleImports.push(`import { UsersModule } from '../users/users.module';`);
  if (leadsImport) externalModuleImports.push(`import { LeadsModule } from '../leads/leads.module';`);

  // Original module imports array
  const modText = moduleLines.join("\n");
  const importsArr = modText.match(/imports:\s*\[([^\]]*)\]/)?.[1]?.trim();
  const providersArr = modText.match(/providers:\s*\[([^\]]*)\]/)?.[1]?.trim() || ServiceName;
  const exportsArr = modText.match(/exports:\s*\[([^\]]*)\]/)?.[1]?.trim() || ServiceName;

  // Service file imports
  const serviceImports = [
    importHeader,
    hasDtos && dtoSymbols.length
      ? `import {\n  ${dtoSymbols.join(",\n  ")},\n} from './${base}.dto';`
      : hasDtos
        ? `import * as Dtos from './${base}.dto';`
        : null,
  ]
    .filter(Boolean)
    .join("\n")
    .replace(/from '\.\/otp\.module'/g, "from '../otp/otp.service'")
    // fix self-references later
    ;

  // Better: fix known service class imports from modules
  let serviceImportBlock = importHeader + "\n";
  // Import OtpService from service file if used
  if (/OtpService/.test(serviceBody)) {
    serviceImportBlock = serviceImportBlock
      .replace(/import\s*\{\s*OtpModule\s*,\s*OtpService\s*\}\s*from\s*['"][^'"]+['"];?/, "import { OtpService } from '../otp/otp.service';")
      .replace(/import\s*\{\s*OtpService\s*,\s*OtpModule\s*\}\s*from\s*['"][^'"]+['"];?/, "import { OtpService } from '../otp/otp.service';")
      .replace(/import\s*\{\s*OtpService\s*\}\s*from\s*['"][^'"]+\.module['"];?/, "import { OtpService } from '../otp/otp.service';");
    if (!/otp\.service/.test(serviceImportBlock) && /OtpService/.test(serviceBody)) {
      // if OtpModule only import with OtpService inline wrong
      if (!serviceImportBlock.includes("OtpService")) {
        serviceImportBlock += `\nimport { OtpService } from '../otp/otp.service';`;
      }
    }
  }
  if (/UsersService/.test(serviceBody) && dirName !== "users") {
    serviceImportBlock = serviceImportBlock.replace(
      /import\s*\{\s*UsersModule\s*,\s*UsersService\s*\}\s*from\s*['"][^'"]+['"];?/,
      "import { UsersService } from '../users/users.service';",
    );
    if (!/users\.service/.test(serviceImportBlock)) {
      serviceImportBlock += `\nimport { UsersService } from '../users/users.service';`;
    }
  }
  if (/LeadsService/.test(serviceBody)) {
    serviceImportBlock = serviceImportBlock
      .replace(/import\s*\{\s*LeadsModule\s*,\s*LeadsService\s*\}\s*from\s*['"][^'"]+['"];?/, "import { LeadsService } from '../leads/leads.service';")
      .replace(/import\s*\{[^}]*LeadsService[^}]*\}\s*from\s*['"][^'"]+leads\.module['"];?/, "import { LeadsService } from '../leads/leads.service';");
    if (!/leads\.service/.test(serviceImportBlock)) {
      serviceImportBlock += `\nimport { LeadsService } from '../leads/leads.service';`;
    }
  }
  // Remove Module-only imports from service
  serviceImportBlock = serviceImportBlock
    .replace(/import\s*\{\s*OtpModule\s*\}\s*from\s*['"][^'"]+['"];?\n?/g, "")
    .replace(/import\s*\{\s*UsersModule\s*\}\s*from\s*['"][^'"]+['"];?\n?/g, "")
    .replace(/import\s*\{\s*LeadsModule\s*\}\s*from\s*['"][^'"]+['"];?\n?/g, "");

  if (hasDtos && dtoSymbols.length) {
    serviceImportBlock += `\nimport {\n  ${dtoSymbols.join(",\n  ")},\n} from './${base}.dto';`;
  }

  // Controller imports
  let controllerImportBlock = importHeader + "\n";
  if (/OtpService/.test(controllerBody)) {
    controllerImportBlock = controllerImportBlock
      .replace(/import\s*\{\s*OtpModule\s*,\s*OtpService\s*\}\s*from\s*['"][^'"]+['"];?/, "import { OtpService } from '../otp/otp.service';")
      .replace(/import\s*\{\s*OtpService\s*,\s*OtpModule\s*\}\s*from\s*['"][^'"]+['"];?/, "import { OtpService } from '../otp/otp.service';");
    if (!controllerImportBlock.includes("OtpService")) {
      controllerImportBlock += `\nimport { OtpService } from '../otp/otp.service';`;
    }
  }
  if (/UsersService/.test(controllerBody) && dirName !== "users") {
    if (!/users\.service/.test(controllerImportBlock)) {
      controllerImportBlock += `\nimport { UsersService } from '../users/users.service';`;
    }
  }
  if (/LeadsService/.test(controllerBody)) {
    if (!/leads\.service/.test(controllerImportBlock)) {
      controllerImportBlock += `\nimport { LeadsService } from '../leads/leads.service';`;
    }
  }
  controllerImportBlock = controllerImportBlock
    .replace(/import\s*\{\s*OtpModule\s*\}\s*from\s*['"][^'"]+['"];?\n?/g, "")
    .replace(/import\s*\{\s*UsersModule\s*\}\s*from\s*['"][^'"]+['"];?\n?/g, "")
    .replace(/import\s*\{\s*LeadsModule\s*\}\s*from\s*['"][^'"]+['"];?\n?/g, "")
    .replace(/import\s*\{\s*OtpModule\s*,\s*OtpService\s*\}\s*from\s*['"][^'"]+['"];?/g, "import { OtpService } from '../otp/otp.service';")
    .replace(/import\s*\{\s*UsersModule\s*,\s*UsersService\s*\}\s*from\s*['"][^'"]+['"];?/g, "import { UsersService } from '../users/users.service';");

  if (hasDtos && dtoSymbols.length) {
    controllerImportBlock += `\nimport {\n  ${dtoSymbols.join(",\n  ")},\n} from './${base}.dto';`;
  }
  controllerImportBlock += `\nimport { ${ServiceName} } from './${base}.service';`;

  // DTO file
  let dtoFile = "";
  if (hasDtos) {
    // DTOs need class-validator / nest common imports from original that dto uses
    const dtoNeed = [
      "IsBoolean",
      "IsOptional",
      "IsString",
      "Length",
      "Matches",
      "MinLength",
      "IsIn",
      "IsNumber",
      "IsArray",
      "IsEmail",
      "Min",
      "Max",
      "ValidateIf",
      "IsNotEmpty",
      "ArrayNotEmpty",
    ];
    const used = dtoNeed.filter((s) => dtoLines.join("\n").includes(s));
    const dtoHeader = [];
    if (used.length) {
      dtoHeader.push(`import {\n  ${used.join(",\n  ")},\n} from 'class-validator';`);
    }
    // Extra imports referenced only in DTO region
    if (dtoLines.join("\n").includes("PAN_FORMAT") || dtoLines.join("\n").includes("isMaskedPan")) {
      // unlikely
    }
    // Copy any type imports used only in dto
    const chatTypes = dtoLines.join("\n").includes("ChatAnswers") || dtoLines.join("\n").includes("ChatAnswer");
    dtoFile =
      dtoHeader.join("\n") +
      (dtoHeader.length ? "\n\n" : "") +
      dtoLines.join("\n").trim() +
      "\n";
  }

  // Also support helper types/functions between imports and Injectable (e.g. customer mappers)
  // Already included in dtoLines - good. But types may need React-less server deps.
  // If non-class code in dtoLines needs imports, attach full importHeader for dto file when complex
  if (hasDtos && dtoLines.join("\n").match(/\bTABLE_|\bgetCurrent|\bhashMpin|\badministrative\b|Supabase|OtpService|Inject|from /)) {
    // Use fuller header for non-class helpers (customer has mappers with helpers)
    const complexDto = dtoLines.some((l) => {
      const t = l.trim();
      return t.startsWith("function ") || t.startsWith("export function") || t.startsWith("const ") || t.startsWith("export const") || t.startsWith("type ") || t.startsWith("export type") || t.startsWith("interface ") || t.startsWith("export interface");
    });
    if (complexDto) {
      dtoFile =
        importHeader
          .replace(/import\s*\{\s*OtpModule\s*,\s*OtpService\s*\}\s*from\s*['"][^'"]+['"];?/, "import { OtpService } from '../otp/otp.service';")
          .replace(/import\s*\{\s*UsersModule\s*,\s*UsersService\s*\}\s*from\s*['"][^'"]+['"];?/, "import { UsersService } from '../users/users.service';")
          .replace(/import\s*\{\s*LeadsModule\s*,\s*LeadsService\s*\}\s*from\s*['"][^'"]+['"];?/, "import { LeadsService } from '../leads/leads.service';")
          .replace(/import\s*\{\s*OtpModule\s*\}\s*from\s*['"][^'"]+['"];?\n?/g, "")
          .replace(/import\s*\{\s*UsersModule\s*\}\s*from\s*['"][^'"]+['"];?\n?/g, "")
          .replace(/import\s*\{\s*LeadsModule\s*\}\s*from\s*['"][^'"]+['"];?\n?/g, "") +
        "\n\n" +
        dtoLines.join("\n").trim() +
        "\n";
    }
  }

  // Fix service/controller: remove class-validator from service if only for DTOs
  // Export service/controller
  // Fix:@Injectable class without export
  serviceBody = serviceBody.replace(/@Injectable\(\)\r?\nclass /, "@Injectable()\nexport class ");
  controllerBody = controllerBody.replace(/@Controller\(([^)]*)\)\r?\nclass /, "@Controller($1)\nexport class ");

  const serviceFile = `${serviceImportBlock.trim()}\n\n${serviceBody.trim()}\n`;
  const controllerFile = `${controllerImportBlock.trim()}\n\n${controllerBody.trim()}\n`;

  // Thin module — keep original imports list, point to local files
  // Reconstruct external import lines for modules
  const moduleImportLines = [`import { Module } from '@nestjs/common';`];
  if (importsArr) {
    if (importsArr.includes("OtpModule")) {
      moduleImportLines.push(`import { OtpModule } from '../otp/otp.module';`);
    }
    if (importsArr.includes("UsersModule")) {
      moduleImportLines.push(`import { UsersModule } from '../users/users.module';`);
    }
    if (importsArr.includes("LeadsModule")) {
      moduleImportLines.push(`import { LeadsModule } from '../leads/leads.module';`);
    }
  }
  moduleImportLines.push(`import { ${ControllerName} } from './${base}.controller';`);
  moduleImportLines.push(`import { ${ServiceName} } from './${base}.service';`);

  // Re-export service for convenience + types from dto if any
  const reExports = [
    `export { ${ServiceName} } from './${base}.service';`,
    `export { ${ControllerName} } from './${base}.controller';`,
  ];
  if (hasDtos && dtoSymbols.length) {
    reExports.push(`export {\n  ${dtoSymbols.join(",\n  ")},\n} from './${base}.dto';`);
  }

  const moduleFile = `${moduleImportLines.join("\n")}

@Module({
${importsArr ? `  imports: [${importsArr}],\n` : ""}  controllers: [${ControllerName}],
  providers: [${providersArr}],
  exports: [${exportsArr}],
})
export class ${ModuleName} {}

${reExports.join("\n")}
`;

  fs.writeFileSync(path.join(dir, `${base}.service.ts`), serviceFile);
  fs.writeFileSync(path.join(dir, `${base}.controller.ts`), controllerFile);
  if (hasDtos) {
    fs.writeFileSync(path.join(dir, `${base}.dto.ts`), dtoFile);
  }
  fs.writeFileSync(modulePath, moduleFile);
  console.log(
    "OK",
    dirName,
    "dto=",
    hasDtos ? dtoSymbols.length : 0,
    ServiceName,
    ControllerName,
  );
}

// Prefer Otp first so other modules can depend on otp.service after first pass
const order = [
  "otp",
  "users",
  "auth",
  "banners",
  "services",
  "partner",
  "contact",
  "chat",
  "wallet",
  "payment-accounts",
  "admin",
  "customer",
];

for (const t of order) {
  splitFile(t);
}

console.log("done");
