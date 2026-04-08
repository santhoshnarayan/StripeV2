import SchemaBuilder from "@pothos/core";

export interface PothosContext {
  userId?: string;
}

export const builder = new SchemaBuilder<{
  Context: PothosContext;
}>({});

builder.queryType({});
builder.mutationType({});
