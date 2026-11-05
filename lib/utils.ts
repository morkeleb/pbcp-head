import { createCn } from 'cn/config';

// The theme's own sizes and tracking (app/globals.css @theme). Without them the merge reads `text-meta` as a text
// colour and drops it beside `text-muted-foreground`, and never merges `tracking-meta` with `tracking-normal`.
export const cn = createCn({
  extend: {
    classGroups: {
      'font-size': [{ text: ['masthead', 'masthead-sm', 'day', 'title', 'body', 'lead', 'control', 'meta'] }],
      tracking: [{ tracking: ['editorial', 'meta'] }],
    },
  },
});
