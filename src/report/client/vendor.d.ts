// The Cytoscape extensions ship no types; graph.ts declares the parts of their API it uses.
declare module 'cytoscape-fcose' {
  const ext: import('cytoscape').Ext;
  export default ext;
}

declare module 'cytoscape-expand-collapse' {
  const ext: import('cytoscape').Ext;
  export default ext;
}
