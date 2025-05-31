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
	private static statusBarLoader: vscode.StatusBarItem | undefined;
	private static loaderActivePromise: Promise<void> | null = null;

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

	private async showLoader(text: string): Promise<() => Promise<void>> {
		if (!SolutionExplorerProvider.statusBarLoader) {
			SolutionExplorerProvider.statusBarLoader = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
			SolutionExplorerProvider.statusBarLoader.tooltip = 'Restoring Solution Explorer tree state...';
		}
		const loader = SolutionExplorerProvider.statusBarLoader;
		loader.text = text;
		loader.show();
		const start = Date.now();
		let finished = false;
		return async () => {
			if (finished) return;
			finished = true;
			const elapsed = Date.now() - start;
			const minDuration = 500; // ms
			if (elapsed < minDuration) {
				await new Promise(res => setTimeout(res, minDuration - elapsed));
			}
			loader.hide();
		};
	}

	private async expandParents(item: sln.TreeItem, expandedIds: Set<string>): Promise<void> {
		const parent = item.parent;
		if (parent && parent.id && !expandedIds.has(parent.id)) {
			await this.expandParents(parent, expandedIds);
			if (parent.collapsibleState !== vscode.TreeItemCollapsibleState.Expanded) {
				parent.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
				try {
					await parent.getChildren();
				} catch (err) {
					this.logger.log(`[DEBUG] Error expanding parent: ${err}`);
				}
				this.logger.log(`[DEBUG] Expanded parent ${parent.id}`);
			}
		}
	}

	private async restoreExpandedStateAndScroll() {
		this.logger.log('[DEBUG] restoreExpandedStateAndScroll called');
		console.log('[SolutionExplorer] restoreExpandedStateAndScroll called');
		if (SolutionExplorerProvider.loaderActivePromise) {
			await SolutionExplorerProvider.loaderActivePromise;
			return;
		}
		const expandedIds = this.expandedItemIds;
		if (!expandedIds || expandedIds.size === 0) {
			this.logger.log('[DEBUG] No expandedIds, calling restoreScrollPosition');
			console.log('[SolutionExplorer] No expandedIds, calling restoreScrollPosition');
			await this.restoreScrollPosition();
			return;
		}
		let hideLoader: (() => Promise<void>) | undefined;
		SolutionExplorerProvider.loaderActivePromise = (async () => {
			hideLoader = await this.showLoader('$(sync~spin) Restoring Solution Explorer tree...');
			try {
				// Breadth-first, async-batched expansion: only expand nodes in expandedIds
				let queue: {item: sln.TreeItem, parentId?: string}[] = [];
				for (const root of this.solutionTreeItemCollection.items) {
					queue.push({item: root, parentId: undefined});
				}
				const BATCH_SIZE = 20;
				while (queue.length > 0) {
					const batch = queue.splice(0, BATCH_SIZE);
					const nextQueue: {item: sln.TreeItem, parentId?: string}[] = [];
					for (const {item, parentId} of batch) {
						// Only expand if this node's id is in expandedIds
						if (item.id && expandedIds.has(item.id)) {
							if (item.collapsibleState !== vscode.TreeItemCollapsibleState.Expanded) {
								item.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
								try {
									await item.getChildren();
								} catch (err) {
									this.logger.log(`[DEBUG] Error expanding item: ${err}`);
								}
								this.logger.log(`[DEBUG] Expanded item ${item.id}`);
							}
							// Only enqueue children if this node is expanded
							let children: sln.TreeItem[] = [];
							try {
								children = await item.getChildren();
							} catch {}
							for (const child of children) {
								if (child && child.id) {
									nextQueue.push({item: child, parentId: item.id});
								}
							}
						}
					}
					// Yield to event loop for UI responsiveness
					if (nextQueue.length > 0 || queue.length > 0) {
						await new Promise(res => setTimeout(res, 0));
					}
					queue.push(...nextQueue);
				}
				// Optionally validate tree IDs after build
				for (const root of this.solutionTreeItemCollection.items) {
					await sln.TreeItem.validateTreeIds(root);
				}
				// Restore scroll/selection after expansion, but before hiding loader
				await this.restoreScrollPosition();
			} finally {
				if (hideLoader) await hideLoader();
				SolutionExplorerProvider.loaderActivePromise = null;
			}
		})();
		await SolutionExplorerProvider.loaderActivePromise;
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
		this.logger.log('[DEBUG] createSolutionItems called');
		console.log('[SolutionExplorer] createSolutionItems called');
		if (!this.solutionFinder) { return []; }
		let solutionPaths = await this.solutionFinder.findSolutions();
		if (solutionPaths.length <= 0 && this.solutionFinder.hasWorkspaceRoots) {
			this.logger.log('[DEBUG] No solution paths found, returning empty');
			console.log('[SolutionExplorer] No solution paths found, returning empty');
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
			this.logger.log('[DEBUG] Tree built, calling restoreExpandedStateAndScroll');
			console.log('[SolutionExplorer] Tree built, calling restoreExpandedStateAndScroll');
			this.restoreExpandedStateAndScroll();
		}, 500);
		return this.solutionTreeItemCollection.items;
	}
}
