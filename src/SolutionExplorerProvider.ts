import * as vscode from "vscode";
import * as config from "@extensions/config";
import * as sln from "@tree";

import { IEventAggregator, EventTypes, IEvent, ISubscription, IFileEvent } from "@events";
import { ILogger } from "@logs";
import { TemplateEngineCollection } from "@templates";
import { SolutionFinder } from "./SolutionFinder";
import { SolutionExplorerDragAndDropController } from "./SolutionExplorerDragAndDropController";
import { SolutionTreeItemCollection } from "./SolutionTreeItemCollection";

export class SolutionExplorerProvider extends vscode.Disposable implements vscode.TreeDataProvider<sln.TreeItem> {
	private fileSubscription: ISubscription | undefined;
	private solutionSubscription: ISubscription | undefined;
	private treeView: vscode.TreeView<sln.TreeItem> | undefined;
	private _onDidChangeTreeData: vscode.EventEmitter<sln.TreeItem | undefined> = new vscode.EventEmitter<sln.TreeItem | undefined>();
	private _initPromise: Promise<any> | null = null;
	private static readonly LAST_REVEALED_ITEM_KEY = 'solutionExplorer.lastRevealedItemId';
	private static readonly EXPANDED_IDS_KEY = 'solutionExplorer.expandedItemIds';
	private lastRevealedItemId: string | undefined;
	private expandedItemIds: Set<string> = new Set();
	private restoringScrollPosition = false;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly solutionFinder: SolutionFinder,
		private readonly solutionTreeItemCollection: SolutionTreeItemCollection,
		private readonly dragAndDropController: SolutionExplorerDragAndDropController,
		private readonly templateEngineCollection: TemplateEngineCollection,
		public readonly eventAggregator: IEventAggregator,
		public readonly logger: ILogger
	) {

		super(() => this.dispose());
		vscode.window.onDidChangeActiveTextEditor(() => this.onActiveEditorChanged());
		//vscode.window.onDidChangeVisibleTextEditors(data => this.onVisibleEditorsChanged(data));
	}

	public get onDidChangeTreeData(): vscode.Event<sln.TreeItem | undefined> {
		return this._onDidChangeTreeData.event;
	}



	public register() {
		if (!this.solutionFinder) { return; }
		this.solutionFinder.register();

		let showMode = config.getShowMode();
		vscode.commands.executeCommand('setContext', 'solutionExplorer.viewInActivityBar', showMode === "activityBar");
		vscode.commands.executeCommand('setContext', 'solutionExplorer.viewInExplorer', showMode === "explorer");
		vscode.commands.executeCommand('setContext', 'solutionExplorer.viewInNone', showMode === "none");
		vscode.commands.executeCommand('setContext', 'solutionExplorer.loadedFlag', !false);
		vscode.commands.executeCommand('setContext', 'solutionexplorer.viewTypes', ["slnexpl", "slnbrw"]);

		if (showMode !== "none") {
			const options = {
				treeDataProvider: this,
				dragAndDropController: this.dragAndDropController,
				canSelectMany: true,
				showCollapseAll: true
			};
			this.solutionSubscription = this.eventAggregator.subscribe(EventTypes.solution, evt => this.onSolutionEvent(evt));
			this.fileSubscription = this.eventAggregator.subscribe(EventTypes.file, evt => this.onFileEvent(evt));
			if (showMode === "activityBar") {
				this.treeView = vscode.window.createTreeView('slnbrw', options);
			} else if (showMode === "explorer") {
				this.treeView = vscode.window.createTreeView('slnexpl', options);
			}
			// Restore expanded state from workspaceState
			const savedExpanded = this.context.workspaceState.get<string[]>(SolutionExplorerProvider.EXPANDED_IDS_KEY, []);
			this.expandedItemIds = new Set(savedExpanded);
			// Listen for expand/collapse events
			this.treeView?.onDidExpandElement(ev => {
				if (ev.element.id) {
					this.expandedItemIds.add(ev.element.id);
					this.context.workspaceState.update(SolutionExplorerProvider.EXPANDED_IDS_KEY, Array.from(this.expandedItemIds));
				}
			});
			this.treeView?.onDidCollapseElement(ev => {
				if (ev.element.id) {
					this.expandedItemIds.delete(ev.element.id);
					this.context.workspaceState.update(SolutionExplorerProvider.EXPANDED_IDS_KEY, Array.from(this.expandedItemIds));
				}
			});
			this.treeView?.onDidChangeSelection(ev => {
				let selectionContext = undefined;
				if (ev.selection.length === 1) {
					selectionContext = ev.selection[0].contextValue;
				}
				else if (ev.selection.length > 1) {
					selectionContext = sln.ContextValues.multipleSelection;
				}
				vscode.commands.executeCommand('setContext', 'solutionExplorer.selectionContext', selectionContext);
				// Save last revealed item id
				if (!this.restoringScrollPosition && ev.selection.length > 0 && ev.selection[0].id) {
					this.lastRevealedItemId = ev.selection[0].id;
					this.context.workspaceState.update(SolutionExplorerProvider.LAST_REVEALED_ITEM_KEY, this.lastRevealedItemId);
					this.logger.log(`[DEBUG] Saved lastRevealedItemId: ${this.lastRevealedItemId}`);
					console.log('[SolutionExplorer] Saved lastRevealedItemId:', this.lastRevealedItemId);
				}
			});
			this.treeView?.onDidChangeVisibility(ev => {
				if (!ev.visible) return;
				this.logger.log('[DEBUG] TreeView became visible, attempting to restore scroll position');
				console.log('[SolutionExplorer] TreeView became visible, attempting to restore scroll position');
				this.restoreScrollPosition();
			});
		}
	}

	public unregister() {
		this.solutionTreeItemCollection.reset();
		this.templateEngineCollection.reset();

		if (this.solutionSubscription) {
			this.solutionSubscription.dispose();
			this.solutionSubscription = undefined;
		}

		if (this.fileSubscription) {
			this.fileSubscription.dispose();
			this.fileSubscription = undefined;
		}

		if (this.treeView) {
			this.treeView.dispose();
			this.treeView = undefined;
		}
	}

	public refresh(item?: sln.TreeItem): void {
		if (!item) {
			this.solutionTreeItemCollection.reset();
		}

		this._onDidChangeTreeData.fire(item);
	}

	public getTreeItem(element: sln.TreeItem): vscode.TreeItem {
		return element;
	}

	public getSelectedItems(): readonly sln.TreeItem[] | undefined {
		return this.treeView?.selection;
	}

	public getChildren(element?: sln.TreeItem): Thenable<sln.TreeItem[]> | undefined {
		if (!this.solutionFinder.hasWorkspaceRoots) {
			this.logger.log('No .sln found in workspace');
			return Promise.resolve([]);
		}

		if (element) {
			return element.getChildren();
		}

		if (!element && this.solutionTreeItemCollection.hasChildren) {
			return Promise.resolve(this.solutionTreeItemCollection.items);
		}

		if (!element && !this.solutionTreeItemCollection.hasChildren) {
			if (!this._initPromise) {
				// Always reset before rebuilding
				this.solutionTreeItemCollection.reset();
				this._initPromise = this.createSolutionItems().finally(() => {
					this._initPromise = null;
				});
			}
			return this._initPromise.then(items => items || []);
		}
	}

	public getParent(element: sln.TreeItem): sln.TreeItem | undefined {
		return element.parent;
	}

	public async selectFile(filepath: string): Promise<void> {
		if (!this.solutionTreeItemCollection.hasChildren) { return; }
		for (let i = 0; i < this.solutionTreeItemCollection.length; i++) {
			let result = await this.solutionTreeItemCollection.getItem(i).search(filepath);
			if (result) {
				this.selectTreeItem(result);
				return;
			}
		}
	}

	public async selectActiveDocument(): Promise<void> {
		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Window,
			title: 'Locating active document in Solution Explorer...'
		}, async () => {
			if (vscode.window.activeTextEditor) {
				await this.selectFile(vscode.window.activeTextEditor.document.uri.fsPath);
			}
		});
	}

	public focus(): void {
		if (this.treeView) {
			const element = this.treeView.selection[0];
			this.treeView.reveal(element, { select: false, focus: true });
		}
	}

	private selectTreeItem(element: sln.TreeItem): void {
		if (this.treeView) {
			this.treeView.reveal(element, { select: true, focus: true });
		}
	}

	private async restoreScrollPosition() {
		if (!this.treeView) return;
		if (this.restoringScrollPosition) return;
		this.restoringScrollPosition = true;
		try {
			const lastId = this.lastRevealedItemId || this.context.workspaceState.get<string>(SolutionExplorerProvider.LAST_REVEALED_ITEM_KEY);
			this.logger.log(`[DEBUG] Attempting to restore scroll position to itemId: ${lastId}`);
			console.log('[SolutionExplorer] Attempting to restore scroll position to itemId:', lastId);
			if (lastId) {
				// Wait for tree to be ready
				await new Promise(resolve => setTimeout(resolve, 300));
				let item = await this.solutionTreeItemCollection.findAndExpandTreeItemById(lastId);
				this.logger.log(`[DEBUG] Item lookup for id ${lastId}: ${item ? 'found' : 'not found'}`);
				console.log('[SolutionExplorer] Item lookup for id', lastId, item ? 'found' : 'not found');
				if (!item) {
					// Fallback: try to find the closest parent by ID prefix
					item = await this.solutionTreeItemCollection.findClosestParentByIdPrefix(lastId);
					this.logger.log(`[DEBUG] Fallback: Closest parent for id ${lastId}: ${item ? item.id : 'not found'}`);
					console.log('[SolutionExplorer] Fallback: Closest parent for id', lastId, item ? item.id : 'not found');
				}
				if (item) {
					await this.treeView.reveal(item, { select: false, focus: false });
					this.logger.log(`[DEBUG] Revealed item ${item.id} in treeView`);
					console.log('[SolutionExplorer] Revealed item', item.id, 'in treeView');
				} else {
					this.logger.log(`[DEBUG] Could not find item with id ${lastId} or any parent to reveal`);
					console.log('[SolutionExplorer] Could not find item with id', lastId, 'or any parent to reveal');
				}
			}
		} catch (err) {
			this.logger.log('[ERROR] Error restoring scroll position: ' + err);
		} finally {
			this.restoringScrollPosition = false;
		}
	}

	private async restoreExpandedState() {
		const expandedIds = this.expandedItemIds;
		if (!expandedIds || expandedIds.size === 0) return;
		// 1. Expand only first-level expanded nodes immediately
		const expandImmediate = async (items: sln.TreeItem[]) => {
			const toExpand: sln.TreeItem[] = [];
			for (const item of items) {
				if (!item) continue;
				if (item.id && expandedIds.has(item.id)) {
					item.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
					await item.getChildren();
					toExpand.push(item);
				}
			}
			return toExpand;
		};
		// 2. Expand deeper nodes in small async batches (background)
		const expandDeepAsync = async (parents: sln.TreeItem[], depth: number) => {
			if (depth > 10) return; // avoid runaway recursion
			const batch: Promise<void>[] = [];
			for (const parent of parents) {
				const children = await parent.getChildren();
				for (const child of children) {
					if (child.id && expandedIds.has(child.id)) {
						child.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
						batch.push(child.getChildren().then(() => {}));
					}
				}
				// Schedule next level after a short delay
				setTimeout(() => expandDeepAsync(children, depth + 1), 50);
			}
			await Promise.all(batch);
		};
		// Start: expand first-level, then schedule deeper expansion
		const firstLevel = await expandImmediate(this.solutionTreeItemCollection.items);
		setTimeout(() => expandDeepAsync(firstLevel, 1), 100);
	}

	private onActiveEditorChanged(): void {
		let shouldExecute = config.getTrackActiveItem();
		if (!shouldExecute) { return; }
		if (!vscode.window.activeTextEditor) { return; }
		if (vscode.window.activeTextEditor.document.uri.scheme !== 'file') { return; }
		this.selectActiveDocument();
	}

	private onSolutionEvent(event: IEvent): void {
		this.solutionTreeItemCollection.reset();
		this.refresh();
	}

	private onFileEvent(event: IEvent): void {
		let fileEvent = <IFileEvent>event;
		if (this.solutionFinder.isWorkspaceSolutionFile(fileEvent.path)) {
			this.solutionTreeItemCollection.reset();
			this.refresh();
		}
	}

	private async createSolutionItems(): Promise<sln.TreeItem[]> {
		if (!this.solutionFinder) { return []; }
		let solutionPaths = await this.solutionFinder.findSolutions();
		if (solutionPaths.length <= 0 && this.solutionFinder.hasWorkspaceRoots) {
			// return empty to show welcome view
			return [];
		}
		this.templateEngineCollection.reset();
		for (let i = 0; i < solutionPaths.length; i++) {
			let s = solutionPaths[i];
			await this.solutionTreeItemCollection.addSolution(s.sln, s.root, this);
			this.templateEngineCollection.createTemplateEngine(s.root);
		}
		// Restore scroll position after tree is built
		setTimeout(() => {
			this.logger.log('[DEBUG] Tree built, calling restoreScrollPosition');
			console.log('[SolutionExplorer] Tree built, calling restoreScrollPosition');
			this.restoreExpandedState();
			this.restoreScrollPosition();
		}, 500);
		return this.solutionTreeItemCollection.items;
	}
}
