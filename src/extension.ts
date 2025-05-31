import * as vscode from "vscode";
import * as config from "@extensions/config";
import { EventAggregator } from "@events";
import { Logger } from "@logs";
import { ActionsRunner } from "./ActionsRunner";
import { SolutionTreeItemCollection } from "./SolutionTreeItemCollection";
import { SolutionFinder } from "./SolutionFinder";
import { SolutionExplorerDragAndDropController } from "./SolutionExplorerDragAndDropController";
import { SolutionExplorerProvider } from "./SolutionExplorerProvider";
import { SolutionExplorerCommands } from "./SolutionExplorerCommands";
import { SolutionExplorerFileWatcher } from "./SolutionExplorerFileWatcher";
import { SolutionExplorerOutputChannel } from "./SolutionExplorerOutputChannel";
import { OmnisharpIntegrationService } from "./OmnisharpIntegrationService";
import { LanguageExtensions } from "./language";
import { TemplateEngineCollection } from "@templates";

export async function activate(context: vscode.ExtensionContext) {
	const paths = vscode.workspace.workspaceFolders?.map(w => w.uri.fsPath) || [];
    const eventAggregator = new EventAggregator();
    const logger = new Logger(eventAggregator);
    const actionsRunner = new ActionsRunner(logger);
    const solutionTreeItemCollection = new SolutionTreeItemCollection();
    const solutionFinder = new SolutionFinder(paths, eventAggregator);
    const solutionExplorerDragAndDropController = new SolutionExplorerDragAndDropController(actionsRunner, solutionTreeItemCollection);
    const templateEngineCollection = new TemplateEngineCollection();
    const solutionExplorerProvider = new SolutionExplorerProvider(context, solutionFinder, solutionTreeItemCollection, solutionExplorerDragAndDropController, templateEngineCollection, eventAggregator, logger);
    const solutionExplorerCommands = new SolutionExplorerCommands(context, solutionExplorerProvider, actionsRunner, templateEngineCollection, eventAggregator);
    const solutionExplorerFileWatcher = new SolutionExplorerFileWatcher(eventAggregator);
    const solutionExplorerOutputChannel = new SolutionExplorerOutputChannel(eventAggregator);
    const omnisharpIntegrationService = new OmnisharpIntegrationService(eventAggregator);
    const nugetCompletionItemProvider = new LanguageExtensions(context);

    register(context, config);
    register(context, eventAggregator);
    register(context, logger);
    register(context, actionsRunner);
    register(context, solutionTreeItemCollection);
    register(context, solutionFinder);
    register(context, solutionExplorerDragAndDropController);
    register(context, templateEngineCollection);
    register(context, solutionExplorerProvider);
    // Force Solution Explorer to load on startup
    solutionExplorerProvider.getChildren();
    register(context, solutionExplorerCommands);
    register(context, solutionExplorerFileWatcher);
    register(context, solutionExplorerOutputChannel);
    register(context, omnisharpIntegrationService);
    register(context, nugetCompletionItemProvider);

    // After all registrations, check for C#/.NET project and focus Solution Explorer if found
    const folders = vscode.workspace.workspaceFolders || [];
    let foundDotNet = false;
    for (const folder of folders) {
        const sln = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, "**/*.sln"), null, 1);
        const csproj = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, "**/*.csproj"), null, 1);
        const fsproj = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, "**/*.fsproj"), null, 1);
        if (sln.length > 0 || csproj.length > 0 || fsproj.length > 0) {
            foundDotNet = true;
            break;
        }
    }
    if (foundDotNet) {
        setTimeout(async () => {
            try { await vscode.commands.executeCommand('workbench.view.extension.sln_explorer'); } catch {}
            try { await vscode.commands.executeCommand('workbench.view.extension.slnexpl'); } catch {}
            try { await vscode.commands.executeCommand('workbench.view.extension.slnbrw'); } catch {}
        }, 1000);
    }
}

export function deactivate() {
	for(let i = 0; i < unregistables.length; i++) {
		unregistables[i].unregister();
	}

	unregistables = [];
}

type Unregistable = { unregister(): void };

type Registable = { register(): void };

let unregistables = new Array<Unregistable>();

function isUnregistable(object: any): object is Unregistable {
    return 'unregister' in object;
}

function isRegistable(object: any): object is Registable {
    return 'register' in object;
}

function isDisposable(object: any): object is vscode.Disposable {
    return 'dispose' in object;
}

function register(context: vscode.ExtensionContext, service: any) : void {
    if (isRegistable(service)) {
	    service.register();
    }

	if (isUnregistable(service)) {
		unregistables.push(service);
	}

    if (isDisposable(service)) {
        context.subscriptions.push(service);
    }
}
