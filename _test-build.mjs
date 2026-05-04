import { buildReportPDF } from './lib/buildReport.js';
import { writeFile } from 'node:fs/promises';

const sample = {
  firstName: 'Yentl',
  total: 8,
  tier: { name: 'The Rising Voice', tagline: "You're currently building momentum, but a few gaps are holding you back." },
  subs: { footprint: 3, clarity: 1, authority: 0, cadence: 0, visual: 2, network: 2 },
  executiveSummary: 'Yentl, your headline lists two companies but does not clearly show what either does to help other people or businesses. Pick one audience and write a sentence about how your experience can support them.',
  dimensionCommentary: {
    footprint: 'Verified creator with 5,194 followers. Easy to find online.',
    clarity:   'Headline names titles and companies - does not clearly explain what you excel at.',
    authority: 'No press mentions, talks, or awards showed up in our scan.',
    cadence:   'We saw zero posts in the last 90 days. The platform is quiet.',
    visual:    'Profile photo looks good. The banner is missing or generic.',
    network:   '5,194 followers, but no recent likes or comments to anchor them.'
  },
  moves: [
    { title: 'Pick one thing and say it', why: 'Right now your headline tells people what you have, not what you do. Pick one audience and one promise.', firstStep: 'Open LinkedIn. Edit your headline. Try: "I help [audience] [outcome]."', service: 'strategy' },
    { title: 'Post once, this Tuesday', why: 'You have 5K followers and zero recent posts. One post starts the rhythm.', firstStep: 'Write 200 words on the most useful thing you learned this month. Hit publish.', service: 'content' },
    { title: 'Get a banner that means something', why: 'Your photo is good. The banner is empty. It is the biggest piece of free real estate on your profile.', firstStep: 'Choose a clear, bold one-line promise. Put it on a clean background and upload as your profile banner.', service: 'photo' }
  ]
};

const bytes = await buildReportPDF(sample);
await writeFile('/sessions/tender-vigilant-lovelace/mnt/outputs/sample-v2.pdf', bytes);
console.log('OK', bytes.length, 'bytes');
