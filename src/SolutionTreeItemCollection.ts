import { SolutionExplorerProvider } from "@SolutionExplorerProvider";
import { SolutionFactory } from "@core/Solutions";
import { TreeItem, TreeItemFactory } from "@tree";


export class SolutionTreeItemCollection {
	private children: TreeItem[] | undefined = undefined;

	public get length(): number {
		return this.children ? this.children.length : 0;
	}

	public get hasChildren(): boolean {
		return this.children !== undefined;
	}

	public get items(): TreeItem[] {
		return this.children || [];
	}

	public getItem(index: number): TreeItem {
		if (!this.children || !this.children[index]) { throw new Error("Invalid index in SolutionItemCollection"); }
		return this.children[index];
	}

	public reset(): void {
		this.children = undefined;
	}

	public async addSolution(solutionPath: string, rootPath: string, solutionProvider: SolutionExplorerProvider): Promise<void> {
		const solution = await SolutionFactory.load(solutionPath);
		const item = await TreeItemFactory.createFromSolution(solutionProvider, solution, rootPath);
		if (!this.children) {
			this.children = [];
		}

		this.children.push(item);
	}

	public getLoadedChildTreeItemById(id: string): TreeItem | undefined {
		if (!this.children) { return undefined; }
		return SolutionTreeItemCollection.getInternalLoadedChildTreeItemById(id, this.children);
	}

	private static getInternalLoadedChildTreeItemById(id: string, children: TreeItem[]): TreeItem | undefined  {
        for (const child of children) {
            if (!child) {
                continue;
            }

            if (child.id === id) {
                return child;
            }

            const found = SolutionTreeItemCollection.getInternalLoadedChildTreeItemById(id, (child as any).children || []);
            if (found) {
                return found;
            }
        }

        return undefined;
    }

    /**
     * Recursively and asynchronously expands/loads children until the item with the given ID is found.
     * Logs all visited IDs for debugging.
     */
    public async findAndExpandTreeItemById(id: string): Promise<TreeItem | undefined> {
        if (!this.children) return undefined;
        const visited: string[] = [];
        const found = await SolutionTreeItemCollection.findAndExpandInternal(id, this.children, visited);
        // Log all IDs in the tree after search
        console.log('[SolutionExplorer] All tree item IDs after build:', visited);
        return found;
    }

    private static async findAndExpandInternal(id: string, children: TreeItem[], visited: string[]): Promise<TreeItem | undefined> {
        for (const child of children) {
            if (!child) continue;
            visited.push(child.id || '(no id)');
            if (child.id === id) return child;
            // Ensure children are loaded and get them via public API
            const loadedChildren = await child.getChildren();
            const found = await SolutionTreeItemCollection.findAndExpandInternal(id, loadedChildren, visited);
            if (found) return found;
        }
        return undefined;
    }

    /**
     * Fallback: Find the closest parent by ID prefix if the exact item is not found.
     */
    public async findClosestParentByIdPrefix(id: string): Promise<TreeItem | undefined> {
        if (!this.children) return undefined;
        const all: TreeItem[] = [];
        await SolutionTreeItemCollection.collectAllItems(this.children, all);
        // Sort by longest prefix match
        all.sort((a, b) => (b.id && id.startsWith(b.id) ? b.id.length : 0) - (a.id && id.startsWith(a.id) ? a.id.length : 0));
        return all.find(item => item.id && id.startsWith(item.id));
    }
    private static async collectAllItems(children: TreeItem[], all: TreeItem[]): Promise<void> {
        for (const child of children) {
            if (!child) continue;
            all.push(child);
            const loadedChildren = await child.getChildren();
            await SolutionTreeItemCollection.collectAllItems(loadedChildren, all);
        }
    }
}
