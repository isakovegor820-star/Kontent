export type EditableTreeNode = {
  readonly nodeType: number;
  readonly nodeValue?: string | null;
  readonly tagName?: string;
  readonly childNodes?: ArrayLike<EditableTreeNode>;
};

export function serializeEditableText(
  root: EditableTreeNode,
  onElementRange?: (node: EditableTreeNode, start: number, end: number) => void,
): string;
