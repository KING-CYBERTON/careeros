// CAREEROS: the MIT notices from the repository NOTICE file, for the licenses page on web and mobile.
// notice.test.ts checks every string below against NOTICE, so the two cannot drift. Keep the wording verbatim.

/** The header of NOTICE: who owns what in this product. */
export const NOTICE_INTRO =
	"CareerOS\nCopyright (c) 2026 Stephen (CareerOS). All rights reserved for original CareerOS code,\nexcept where third-party licenses below apply.\n\nThis product includes software developed by third parties under the MIT License.\nTheir copyright and permission notices are reproduced below as the MIT License requires.\nThe upstream LICENSE file at the repository root is kept unchanged.\n\n--";

/** One third-party component and the MIT notice it ships under. */
export type NoticeEntry = { name: string; url: string; license: string };

export const NOTICE_ENTRIES: readonly NoticeEntry[] = [
	{
		name: "Reactive Resume (base codebase)",
		url: "https://github.com/reactive-resume/reactive-resume",
		license:
			'MIT License\n\nCopyright (c) 2026 Amruth Pillai\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.\n\n--',
	},
	{
		name: "JobSync (feature reference; logic ported or re-implemented)",
		url: "https://github.com/Gsync/jobsync",
		license:
			'MIT License\n\nCopyright (c) 2024 gsync\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.\n\n--',
	},
];
