import superagent, { SuperAgentRequest } from "superagent";
import { URL } from "url";
import process from "process";
import path from "path";
import fs from "fs";
import rimraf from "rimraf";
import yargs from "yargs";
import tar from "tar";
import mustache from "mustache";
import spdx from "spdx-expression-parse";
// eslint-disable-next-line @typescript-eslint/ban-ts-ignore
// @ts-ignore
import cacheModule from "cache-service-cache-module";
// eslint-disable-next-line @typescript-eslint/ban-ts-ignore
// @ts-ignore
import cachePlugin from "superagent-cache-plugin";
import superagentProxy from "superagent-proxy";
import { retrieveAuthToken } from "./retrieveAuthToken";

const cache = new cacheModule();
const superagentCache = cachePlugin(cache);
superagentProxy(superagent);
const proxy = process.env.http_proxy || "";

const AUTH_TOKEN: Record<string, string | null> = {};
let CWD = "";
let REGISTRY: string[] = ["https://registry.npmjs.org"];
let PKG_JSON_PATH = "";
let PKG_LOCK_JSON_PATH = "";
let NODE_MODULES_PATH = "";
let TMP_FOLDER_PATH = "";
let OUT_PATH = "";
let TEMPLATE_PATH = "";
let GROUP = true;
let RUN_PKG_LOCK = false;
let SPDX = true;
let ONLY_SPDX = false;
let ERR_MISSING = false;
let INSECURE = false;
const NO_MATCH_EXTENSIONS = [
  "js",
  "ts",
  "d.ts",
  "c",
  "cpp",
  "h",
  "class",
  "pl",
  "sh",
];

function getAllFiles(dirPath: string, arrayOfFiles?: string[]): string[] {
  const files = fs.readdirSync(dirPath);

  arrayOfFiles = arrayOfFiles || [];

  files.forEach(function (file) {
    if (fs.statSync(dirPath + "/" + file).isDirectory()) {
      arrayOfFiles = getAllFiles(path.join(dirPath, file), arrayOfFiles);
    } else {
      arrayOfFiles?.push(path.join(dirPath, file));
    }
  });

  return arrayOfFiles;
}

async function getPkgLicense(pkg: PkgInfo): Promise<LicenseInfo> {
  // Get package info from registry
  const license: LicenseInfo = {
    pkg: pkg,
    type: "",
    text: [],
  };
  for (let i = 0; i < REGISTRY.length; i++) {
    const registry = REGISTRY[i];
    const url = new URL(registry);
    url.pathname = pkg.name;
    // Get registry info
    const result = await new Promise<boolean>((resolve) => {
      let req = superagent.get(url.toString());
      if (INSECURE) {
        req = req.disableTLSCerts();
      }
      req
        .proxy(proxy)
        .auth(AUTH_TOKEN[registry] ?? "", { type: "bearer" })
        .timeout(10000)
        .then((res) => {
          license.type = res.body.license;
          if (!res.body.license) {
            try {
              license.type = res.body.versions[pkg.version].license;
            } catch (e) {
              console.error(
                `Could not find license info in registry for ${pkg.name} ${pkg.version}`
              );
              resolve(false);
              return;
            }
          }
          license.pkg.homepage = res.body.homepage || res.body.repository?.url;
          if (!pkg.tarball) {
            try {
              pkg.tarball = res.body.versions[pkg.version].dist.tarball;
            } catch (e) {
              console.error(
                `Could not find version info for ${pkg.name} ${pkg.version}`
              );
              resolve(false);
              return;
            }
          }
          resolve(true);
          return;
        })
        .catch((e) => {
          if (e?.status) {
            if (parseInt(e.status) == 404) {
              resolve(false);
              return;
            }
            console.warn(
              `Could not get info from registry for ${pkg.name}! HTTP status code ${e.status}`
            );
          } else {
            console.warn(
              `Could not get info from registry for ${pkg.name}! Error: ${e}`
            );
          }
          resolve(false);
          return;
        });
    });

    if (!result && i != REGISTRY.length - 1) {
      continue;
    }

    // look for license in node_modules
    if (!ONLY_SPDX) {
      try {
        let files = getAllFiles(path.join(NODE_MODULES_PATH, pkg.name));
        files = files.filter((path) => {
          const regex = /[/\\](LICENSE|LICENCE|COPYING|COPYRIGHT)\.?.*/gim;
          const extension = path.split(".");
          if (NO_MATCH_EXTENSIONS.includes(extension[extension.length - 1])) {
            return false;
          }
          if (regex.test(path)) {
            return true;
          }
          return false;
        });
        for (const path of files) {
          license.text.push(
            fs
              .readFileSync(path)
              .toString()
              .trim()
              .replace(/\r\n/gm, "\n")
              .replace(/ +$/gm, "")
          );
        }
      } catch (e) {
        /* empty */
      }
    }

    // Download tarball if not found locally
    const fileName = `${pkg.name.replace("/", ".")}-${pkg.version}`;
    if (!ONLY_SPDX && !license.text.length) {
      const hasTarball = await new Promise<boolean>((resolve) => {
        if (!pkg.tarball) {
          console.error("No tarball location", pkg);
          resolve(false);
          return license;
        }
        let req = superagent.get(pkg.tarball);
        if (INSECURE) {
          req = req.disableTLSCerts();
        }
        req
          .proxy(proxy)
          .auth(AUTH_TOKEN[registry] ?? "", { type: "bearer" })
          .timeout(10000)
          .buffer(true)
          .parse(superagent.parse["application/octet-stream"])
          .then((res) => {
            fs.writeFileSync(
              path.join(TMP_FOLDER_PATH, fileName + ".tgz"),
              res.body
            );
            resolve(true);
          });
      });

      if (hasTarball) {
        // Extract license
        const extractFolder = path.join(TMP_FOLDER_PATH, fileName);
        if (!fs.existsSync(extractFolder)) {
          fs.mkdirSync(extractFolder);
        }
        await tar.extract({
          cwd: extractFolder,
          file: path.join(TMP_FOLDER_PATH, fileName + ".tgz"),
          // strip: 1,
          filter: (path) => {
            const regex = /[/\\](LICENSE|LICENCE|COPYING|COPYRIGHT)\.?.*/gim;
            const extension = path.split(".");
            if (NO_MATCH_EXTENSIONS.includes(extension[extension.length - 1])) {
              return false;
            }
            if (regex.test(path)) {
              return true;
            }
            return false;
          },
        });

        // Throw license files into array
        const files = getAllFiles(extractFolder);
        for (const path of files) {
          license.text.push(
            fs
              .readFileSync(path)
              .toString()
              .trim()
              .replace(/\r\n/gm, "\n")
              .replace(/ +$/gm, "")
          );
        }
      }
    }

    break;
  }

  if (!license.text.length) {
    if (!ONLY_SPDX) {
      console.warn(
        `No license file found for package ${license.pkg.name}${
          SPDX ? "" : ", using SPDX string"
        }.`
      );
    }

    if (SPDX) {
      // eslint-disable-next-line no-async-promise-executor
      await new Promise<void>(async (resolve) => {
        let parsedLicense: SPDXLicense | SPDXJunction | undefined;
        try {
          parsedLicense = spdx(license.type);
        } catch (e) {
          console.error(
            `Error: Could not parse license string '${license.type}' for ${license.pkg.name}!`
          );
          resolve();
          return;
        }
        if (!parsedLicense) {
          resolve();
          return;
        }
        const licenseStrings: string[] = [];
        if ("license" in parsedLicense) {
          licenseStrings.push(parsedLicense.license);
        } else {
          const getLicenses = (license: SPDXJunction): void => {
            if ("license" in license.left) {
              licenseStrings.push(license.left.license);
            } else {
              getLicenses(license.left);
            }

            if ("license" in license.right) {
              licenseStrings.push(license.right.license);
            } else {
              getLicenses(license.right);
            }
          };
          getLicenses(parsedLicense);
        }

        for (const licenseString of licenseStrings) {
          await new Promise<void>((resolve) => {
            let req = superagent.get(
              `https://raw.githubusercontent.com/spdx/license-list-data/master/text/${licenseString}.txt`
            );
            if (INSECURE) {
              req = req.disableTLSCerts();
            }
            req
              .proxy(proxy)
              .timeout(10000)
              .use(superagentCache)
              .then((res) => {
                license.text.push(res.text);
                resolve();
              })
              .catch((e) => {
                console.warn(
                  `Error downloading license for ${license.pkg.name}. L: ${licenseString} S: ${e}`
                );
                resolve();
              });
          });
        }
        resolve();
      });
    }

    if (!license.text.length) {
      if (ERR_MISSING) {
        process.exit(1);
      } else {
        console.error(`No license file for ${license.pkg.name}, skipping...`);
      }
    }
  }

  return license;
}

async function main(): Promise<void> {
  for (const regsitry of REGISTRY) {
    const url = new URL(regsitry);
    const fullPath = url.toString().replace(/^(http|https):\/\//, "") || "";
    AUTH_TOKEN[regsitry] = retrieveAuthToken(fullPath);
  }

  let pkgInfo: PkgJsonData | undefined;
  let pkgLockInfo: PkgLockJsonData | undefined;
  try {
    const pkgJson = fs.readFileSync(PKG_JSON_PATH, "utf8");
    pkgInfo = JSON.parse(pkgJson);
    const pkgLockJson = fs.readFileSync(PKG_LOCK_JSON_PATH, "utf8");
    pkgLockInfo = JSON.parse(pkgLockJson);
  } catch (e) {
    console.error("Error parsing package.json or package-lock.json", e);
    process.exit(1);
  }

  if (!pkgInfo) {
    console.error("pkgInfo undefined");
    process.exit(1);
  }

  let keys: string[] = [];
  if (!RUN_PKG_LOCK) {
    if (pkgInfo.dependencies) {
      keys = keys.concat(Object.keys(pkgInfo.dependencies));
    }
    if (pkgInfo.devDependencies) {
      keys = keys.concat(Object.keys(pkgInfo.devDependencies));
    }
    if (pkgInfo.optionalDependencies) {
      keys = keys.concat(Object.keys(pkgInfo.optionalDependencies));
    }
  } else {
    if (pkgLockInfo && pkgLockInfo.dependencies) {
      keys = Object.keys(pkgLockInfo.dependencies);
    }
  }

  const pkgs: PkgInfo[] = [];
  for (const pkg of keys) {
    const info: PkgInfo = { name: pkg, version: "" };
    if (pkgLockInfo) {
      if (pkgLockInfo.dependencies && pkgLockInfo.dependencies[pkg]) {
        info.version = pkgLockInfo.dependencies[pkg].version;
        info.tarball = pkgLockInfo.dependencies[pkg].resolved;
      } else {
        console.warn(`Could not find ${pkg} in package-lock.json! Skipping...`);
        continue;
      }
    }
    pkgs.push(info);
  }

  if (!fs.existsSync(TMP_FOLDER_PATH)) {
    fs.mkdirSync(TMP_FOLDER_PATH);
  }
  const promises: Promise<LicenseInfo>[] = [];
  for (const pkg of pkgs) {
    promises.push(getPkgLicense(pkg));
  }

  const licenses = await Promise.all(promises);
  licenses.sort((a, b) => {
    if (a.pkg.name < b.pkg.name) {
      return -1;
    } else if (a.pkg.name > b.pkg.name) {
      return 1;
    } else {
      return 0;
    }
  });

  const groupedLicenses: GroupedLicense[] = [];
  if (GROUP) {
    for (const license of licenses) {
      for (const i in license.text) {
        const text = license.text[i];
        if (text) {
          let found = false;
          for (const groupedLicense of groupedLicenses) {
            if (groupedLicense.text.includes(text)) {
              groupedLicense.pkgs.push({ ...license.pkg, comma: true });
              found = true;
            }
          }
          if (!found) {
            groupedLicenses.push({
              pkgs: [{ ...license.pkg, comma: true }],
              text,
            });
          }
        }
      }
    }

    for (const license of groupedLicenses) {
      for (const i in license.pkgs) {
        if (i === String(license.pkgs.length - 1)) {
          license.pkgs[i].comma = false;
        }
      }
    }
  }

  const renderLicenses = !GROUP ? licenses : groupedLicenses;
  const outtext = mustache.render(fs.readFileSync(TEMPLATE_PATH).toString(), {
    renderLicenses,
    name: pkgInfo.name,
  });

  fs.writeFileSync(OUT_PATH, outtext);
  rimraf.sync(TMP_FOLDER_PATH);
  console.log("Done!");
}

yargs
  .scriptName("npm-license-generator")
  .command("$0 [folder]", "", (yargs) => {
    const argv = yargs
      .positional("folder", {
        describe:
          "Folder of NPM project. Defaults to current working directory",
        type: "string",
      })
      .option("out-path", {
        describe: "HTML output path",
        type: "string",
        default: "./licenses.html",
      })
      .option("registry", {
        describe: "URL of package registry to use",
        type: "string",
        default: null,
      })
      .option("tmp-folder-name", {
        describe: "Name of temporary folder",
        type: "string",
        default: ".license-gen-tmp",
      })
      .option("template", {
        describe: "Path to custom mustache template",
        type: "string",
      })
      .option("auth", {
        describe:
          "Enable registry authentication, please call npm adduser first.",
        type: "boolean",
        default: false,
      })
      .option("insecure", {
        describe: "Disable SSL certificate validation",
        type: "boolean",
        default: false,
      })
      .option("group", {
        describe: "Group licenses",
        type: "boolean",
        default: true,
      })
      .option("package-lock", {
        describe: "Run on all packages listed in package-lock.json",
        type: "boolean",
        default: false,
      })
      .option("spdx", {
        describe: "Download license file based on SPDX string",
        type: "boolean",
        default: true,
      })
      .option("only-spdx", {
        describe: "Do not download tarballs, only use SPDX string",
        type: "boolean",
        default: false,
      })
      .option("error-missing", {
        describe: "Exit 1 if no license is present for a package",
        type: "boolean",
        default: false,
      }).argv;

    const folder = argv.folder || argv._[0];
    CWD = folder ? path.resolve(folder) : process.cwd();
    REGISTRY =
      argv.registry == null
        ? REGISTRY
        : [...REGISTRY, (argv.registry as any) as string];
    INSECURE = argv["insecure"] ?? false;
    PKG_JSON_PATH = path.resolve(CWD, "package.json");
    PKG_LOCK_JSON_PATH = path.resolve(CWD, "package-lock.json");
    TMP_FOLDER_PATH = path.resolve(CWD, argv["tmp-folder-name"]);
    NODE_MODULES_PATH = path.resolve(CWD, "node_modules");
    OUT_PATH = path.resolve(argv["out-path"]);
    GROUP = argv["group"];
    TEMPLATE_PATH = argv.template
      ? path.resolve(argv.template)
      : path.join(
          __dirname,
          !GROUP ? "template.html" : "template-grouped.html"
        );
    RUN_PKG_LOCK = argv["package-lock"];
    SPDX = argv["spdx"];
    ONLY_SPDX = argv["only-spdx"];
    ERR_MISSING = argv["error-missing"];
    main();
  })
  .help().argv;
