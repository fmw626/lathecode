import { LatheCode } from '../common/lathecode.ts';
import InlineWorker from './editorworker?worker&inline';
import { PixelMove } from '../planner/pixel.ts';
import { FromEditorWorkerMessage, ToEditorWorkerMessage } from './editorworker.ts';

const PX_PER_MM = 100;

export class Editor extends EventTarget {
  private errorContainer: HTMLDivElement;
  private latheCodeInput: HTMLTextAreaElement;
  private planButton: HTMLButtonElement;
  private expandCollapseButton: HTMLButtonElement;
  private moreOptionsSection: HTMLElement;
  private saveButton: HTMLButtonElement;
  private loadButton: HTMLButtonElement;
  private loadSelect: HTMLSelectElement;
  private deleteButton: HTMLButtonElement;
  private saveNameInput: HTMLInputElement;
  private exportButton: HTMLButtonElement;
  private importInput: HTMLInputElement;
  private latheCode: LatheCode | null = null;
  private worker: Worker | null = null;

  constructor(container: HTMLElement) {
    super();

    this.planButton = container.querySelector<HTMLButtonElement>('.planButton')!;
    this.errorContainer = container.querySelector('.errorContainer')!;
    this.latheCodeInput = container.querySelector<HTMLTextAreaElement>('.latheCodeInput')!;
    this.latheCodeInput.addEventListener('input', () => this.update());
    this.latheCodeInput.value = localStorage.getItem('latheCode') || this.latheCodeInput.value;
    this.update();

    container.querySelector<HTMLButtonElement>('.stlButton')!.addEventListener('click', () => {
      this.dispatchEvent(new Event('stl'));
    });

    this.planButton.addEventListener('click', () => {
      this.dispatchEvent(new Event('plan'));
    });

    container.querySelector<HTMLButtonElement>('.imageButton')!.addEventListener('click', () => {
      this.errorContainer.textContent = '';
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.addEventListener('change', () => {
        const selectedFile = input.files?.[0];
        if (selectedFile) this.recognize(selectedFile);
      });
      input.click();
    });

    this.saveButton = container.querySelector<HTMLButtonElement>('.saveButton')!;
    this.loadButton = container.querySelector<HTMLButtonElement>('.loadButton')!;
    this.saveNameInput = container.querySelector<HTMLInputElement>('.saveNameInput')!;
    this.loadSelect = container.querySelector<HTMLSelectElement>('.loadSelect')!;
    this.deleteButton = container.querySelector<HTMLButtonElement>('.deleteButton')!;
    this.exportButton = container.querySelector<HTMLButtonElement>('.exportButton')!;
    this.importInput = container.querySelector<HTMLInputElement>('#importFile')!;
    this.expandCollapseButton = container.querySelector<HTMLButtonElement>('.expandCollapseButton')!;
    this.moreOptionsSection = container.querySelector<HTMLElement>('#moreOptions')!;

    // Add event listeners for save, load, and delete buttons
    this.saveButton.addEventListener('click', () => this.saveLatheCode());
    this.loadButton.addEventListener('click', () => this.loadLatheCode());
    this.deleteButton.addEventListener('click', () => this.deleteLatheCode());
    this.exportButton.addEventListener('click', () => this.exportLocalStorage());
    this.importInput.addEventListener('change', (event) => this.handleImportInputChange(event));
    this.expandCollapseButton.addEventListener('click', () => this.toggleMoreOptions());
    this.updateLoadSelect();
  }

  private handleImportInputChange(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) {
      this.importLocalStorage(file);
    }
  }

  private toggleMoreOptions() {
    this.moreOptionsSection.classList.toggle('expanded');
    if (this.moreOptionsSection.classList.contains('expanded')) {
      this.expandCollapseButton.textContent = 'Less...';
    } else {
      this.expandCollapseButton.textContent = 'More...';
    }
  }

  // Update the loadSelect dropdown
  updateLoadSelect() {
    this.loadSelect.innerHTML = '';

    let hasSavedItems = false;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      // Exclude 'latheCode' from the dropdown options
      if (key && key !== 'latheCode') {
        hasSavedItems = true;
        const option = document.createElement('option');
        option.value = key;
        option.textContent = key;
        this.loadSelect.appendChild(option);
      }
    }

    // If no saved items, add a placeholder
    if (!hasSavedItems) {
      const placeholderOption = document.createElement('option');
      placeholderOption.textContent = 'No items saved';
      placeholderOption.disabled = true; // Make it non-selectable
      this.loadSelect.appendChild(placeholderOption);
    } else {
      // Sort the keys alphabetically if there are saved items
      const sortedOptions = Array.from(this.loadSelect.options)
        .sort((a, b) => a.text.localeCompare(b.text));

      this.loadSelect.innerHTML = '';
      sortedOptions.forEach(option => {
        this.loadSelect.appendChild(option);
      });
    }
  }

  // Save current LatheCode
  saveLatheCode() {
    const saveName = this.saveNameInput.value.trim();
    if (!saveName) return; // Handle empty name case
    localStorage.setItem(saveName, this.latheCodeInput.value);
    this.updateLoadSelect();

    // Set the newly saved item as the selected option in the dropdown
    this.loadSelect.value = saveName;

    this.saveNameInput.value = '';
  }

  // Load LatheCode by name
  loadLatheCode() {
    const loadSelect = document.querySelector<HTMLSelectElement>('.loadSelect')!;
    const selectedName = loadSelect.value;
    const latheCode = localStorage.getItem(selectedName);
    if (latheCode) {
      this.latheCodeInput.value = latheCode;
      this.update(); // Update the editor with the loaded code
    }
  }

  deleteLatheCode() {
    const selectedName = this.loadSelect.value;
    if (selectedName) {
      localStorage.removeItem(selectedName);
      this.updateLoadSelect();
    }
  }

  getLatheCode() {
    return this.latheCode;
  }

  private update() {
    try {
      localStorage.setItem('latheCode', this.latheCodeInput.value);
      this.latheCode = new LatheCode(this.latheCodeInput.value + '\n');
      this.planButton.style.display = this.latheCode.getInsideSegments().length ? 'none' : 'inline';
      this.errorContainer.textContent = '';
    } catch (error: any) {
      this.latheCode = null;
      this.errorContainer.textContent = error.message;
    }
    this.dispatchEvent(new Event('change'));
  }

  private recognize(image: File) {
    const reader = new FileReader();
    reader.onload = async () => {
      let image = reader.result as ArrayBuffer;
      if (this.worker) {
        this.worker.onmessage = null;
        this.worker.terminate();
      }
      const imageHeight = await getImageHeight(image);
      const initialLengthMm = imageHeight / PX_PER_MM;
      const lengthMm = Number(prompt('How long should the part be in mm?', initialLengthMm.toFixed(2)));
      if (isNaN(lengthMm) || lengthMm <= 0) return;
      image = await scaleImage(image, lengthMm / initialLengthMm);
      this.worker = new InlineWorker();
      this.worker.onmessage = (event: MessageEvent<any>) => {
        const m = event.data as FromEditorWorkerMessage;
        if (m.moves && m.moves.length) {
          this.setLatheCodeFromPixelMoves(m.moves.map(m => {
            Object.setPrototypeOf(m, PixelMove.prototype);
            return m;
          }));
        } else if (m.error) {
          this.errorContainer.textContent = m.error;
        }
      };
      const smoothEpsilon = Number(prompt('How smooth should it be? Use values between 1 and 10:', '1'));
      if (isNaN(smoothEpsilon) || smoothEpsilon < 0) return;
      const toWorker: ToEditorWorkerMessage = { image, pxPerMm: 100, smoothEpsilon };
      this.worker.postMessage(toWorker);
    };
    reader.readAsArrayBuffer(image);
  }

  private setLatheCodeFromPixelMoves(moves: PixelMove[]) {
    const lines = moves.map(m => {
      return m.toMove(PX_PER_MM).toLatheCode();
    }).filter(line => !!line);
    this.latheCodeInput.value = lines.join('\n');
    this.update();
  }

  exportLocalStorage() {
    const data: { [key: string]: string } = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key) {
        data[key] = localStorage.getItem(key) ?? '';
      }
    }
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const href = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = href;
    link.download = 'localStorageBackup.json';
    link.click();
    URL.revokeObjectURL(href);
  }

  importLocalStorage(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result as string);
        for (const key in data) {
          if (Object.prototype.hasOwnProperty.call(data, key)) {
            localStorage.setItem(key, data[key]);
          }
        }
        this.updateLoadSelect();
      } catch (e) {
        console.error('Failed to import data: ', e);
      }
    };
    reader.readAsText(file);
  }

}

function getImageHeight(arrayBuffer: ArrayBuffer): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const blob = new Blob([arrayBuffer]);
    const img = new Image();
    img.onload = () => resolve(img.height);
    img.onerror = () => reject(new Error('Failed to load the image.'));
    img.src = URL.createObjectURL(blob);
  });
}

function scaleImage(arrayBuffer: ArrayBuffer, scaleFactor: number): Promise<ArrayBuffer> {
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const blob = new Blob([arrayBuffer]);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const width = img.width * scaleFactor;
      const height = img.height * scaleFactor;
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob((blob) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(new Error('Failed to read the scaled image data.'));
        reader.readAsArrayBuffer(blob!);
      }, 'image/png', 1);
    };
    img.onerror = () => reject(new Error('Failed to load the image.'));
    img.src = URL.createObjectURL(blob);
  });
}
