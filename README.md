# Gamma Automator Chrome Extension

Automates the creation of Gamma presentations from markdown files.

## Installation

1. Open Chrome and go to `chrome://extensions/`
2. Enable "Developer mode" in the top right
3. Click "Load unpacked" and select the `gamma-automator` folder
4. The extension icon should appear in your toolbar

## Usage

1. Prepare your folder structure:
   ```
   extension/
   └── input/
       ├── CourseA/
       │   ├── 01-c.md
       │   ├── 02-c.md
       │   └── ...
       └── CourseB/
           ├── 01-c.md
           ├── 02-c.md
           └── ...
   ```

2. Click the extension icon in Chrome
3. Select your `input` folder using "Select input folder"
4. Click "Start Automation"
5. Wait for processing to complete
6. Download results as JSON file

## How It Works

For each `*-c.md` file found:
1. Opens https://gamma.app/
2. Clicks "Create new"
3. Selects "Paste in text" option
4. Pastes markdown content
5. Selects "Preserve this exact text"
6. Clicks "Continue to prompt editor"
7. Clicks "Generate"
8. Waits for generation to complete
9. Captures the presentation URL
10. Closes the tab and moves to next file

## Output

Results are saved as a JSON file mapping filenames to presentation URLs:
```json
{
  "CourseA/01-c.md": "https://gamma.app/docs/xxxx",
  "CourseA/02-c.md": "https://gamma.app/docs/yyyy",
  "CourseB/01-c.md": "https://gamma.app/docs/zzzz"
}
```

## Troubleshooting

- Make sure you're logged into gamma.app before starting
- Ensure your markdown files end with `-c.md`
- Check that files are in the `input/` folder structure
- If automation fails, check the browser console for errors