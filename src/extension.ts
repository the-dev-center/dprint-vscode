import * as vscode from "vscode";
import { ApprovedConfigPaths } from "./ApprovedConfigPaths";
import { getCombinedDprintConfig } from "./config";
import { DPRINT_CONFIG_FILEPATH_GLOB } from "./constants";
import type { ExtensionBackend } from "./ExtensionBackend";
import { activateLegacy } from "./legacy/context";
import { Logger } from "./logger";
import { activateLsp } from "./lsp";

class GlobalPluginState {
  constructor(
    public readonly outputChannel: vscode.OutputChannel,
    public readonly logger: Logger,
    public readonly extensionBackend: ExtensionBackend,
  ) {
  }

  async dispose() {
    try {
      await this.extensionBackend?.dispose();
    } catch {
      // ignore
    }
    this.outputChannel.dispose();
  }
}

let globalState: GlobalPluginState | undefined;

export async function activate(context: vscode.ExtensionContext) {
  const globalState = await getAndSetNewGlobalState(context);
  const backend = globalState.extensionBackend;
  const logger = globalState.logger;

  let isReInitializing = false;

  async function reInitializeBackend() {
    if (isReInitializing) {
      return;
    }
    isReInitializing = true;
    try {
      await backend.reInitialize();
      logger.logInfo("Extension active!");
    } catch (err) {
      logger.logError("Error initializing:", err);
    } finally {
      isReInitializing = false;
    }
  }

  // Prompt the user to restart when a dprint config file changes,
  // rather than auto-restarting (which races with dprint's own
  // config file modifications during startup).
  let configChangePromptVisible = false;
  function promptReInitializeBackend() {
    if (configChangePromptVisible) {
      return; // Don't stack multiple prompts
    }
    configChangePromptVisible = true;
    const action = "Refresh";
    vscode.window.showInformationMessage(
      "Dprint configuration changed. Refresh plugin to apply?",
      action,
    ).then(selectedAction => {
      configChangePromptVisible = false;
      if (selectedAction === action) {
        reInitializeBackend();
      }
    });
  }

  // reinitialize on workspace folder changes
  context.subscriptions.push(
    vscode.commands.registerCommand("dprint.restart", reInitializeBackend),
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(reInitializeBackend),
  );

  // prompt to reinitialize on configuration file changes
  const fileSystemWatcher = vscode.workspace.createFileSystemWatcher(DPRINT_CONFIG_FILEPATH_GLOB);
  context.subscriptions.push(fileSystemWatcher);
  context.subscriptions.push(fileSystemWatcher.onDidChange(promptReInitializeBackend));
  context.subscriptions.push(fileSystemWatcher.onDidCreate(promptReInitializeBackend));
  context.subscriptions.push(fileSystemWatcher.onDidDelete(promptReInitializeBackend));

  // reinitialize when the vscode configuration changes
  let hasShownLspWarning = false;
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async evt => {
    if (evt.affectsConfiguration("dprint")) {
      if (isLsp() !== backend?.isLsp && !hasShownLspWarning) {
        const action = "Reload";
        vscode.window.showInformationMessage(
          "Changing dprint.experimentalLsp requires reloading the vscode window.",
          action,
        ).then(selectedAction => {
          if (selectedAction === action) {
            vscode.commands.executeCommand("workbench.action.reloadWindow");
          }
        });

        hasShownLspWarning = true;
      } else {
        hasShownLspWarning = false;
        promptReInitializeBackend();
      }
    }
  }));

  context.subscriptions.push({
    async dispose() {
      await clearGlobalState();
    },
  });

  reInitializeBackend();
}

// this method is called when your extension is deactivated
export async function deactivate() {
  await clearGlobalState();
}

async function getAndSetNewGlobalState(context: vscode.ExtensionContext) {
  await clearGlobalState();

  let outputChannel: vscode.OutputChannel | undefined = undefined;
  let logger: Logger | undefined = undefined;
  let backend: ExtensionBackend | undefined = undefined;
  try {
    outputChannel = vscode.window.createOutputChannel("dprint");
    logger = new Logger(outputChannel);
    const approvedPaths = new ApprovedConfigPaths(context);
    backend = isLsp()
      ? activateLsp(logger, approvedPaths)
      : activateLegacy(logger, approvedPaths);
  } catch (err) {
    outputChannel?.dispose();
    throw err;
  }
  globalState = new GlobalPluginState(outputChannel, logger, backend);
  return globalState;
}

async function clearGlobalState() {
  await globalState?.dispose();
  globalState = undefined;
}

function isLsp() {
  return getCombinedDprintConfig(vscode.workspace.workspaceFolders ?? []).experimentalLsp;
}
