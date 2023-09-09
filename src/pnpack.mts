import path from 'node:path';
import os from 'node:os';
import { createWriteStream } from 'node:fs';
import { readdir, stat, access } from 'node:fs/promises';

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { spawn } from 'cross-spawn';
import archiver from 'archiver';

const runPnpmCommand = async (args: string[]): Promise<string> => {
  return new Promise((resolve, reject) => {
    const command = 'pnpm';
    const child = spawn(command, args);
    let output = '';
    let errorOutput = '';

    child.stdout.on('data', (data) => {
      output += data.toString();
    });

    child.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    child.on('exit', (code) => {
      if (code !== 0 || errorOutput) {
        reject(
          new Error(
            `Command "${command} ${args.join(
              ' ',
            )}" exited with code ${code}. Error: ${errorOutput.trim()}`,
          ),
        );
      } else {
        resolve(output.trim());
      }
    });

    child.on('error', (error) => {
      reject(error);
    });
  });
};

const getRootPath = async (): Promise<string> => {
  return runPnpmCommand(['root']);
};

const addToArchive = async (
  absolutePath: string,
  archive: archiver.Archiver,
  verbose: boolean,
): Promise<void> => {
  if (
    !(await access(absolutePath)
      .then(() => true)
      .catch(() => false))
  ) {
    console.warn(`Path "${absolutePath}" does not exist. Skipping...`);
    return;
  }

  const rootPath = await getRootPath();
  const relativePath = absolutePath.replace(rootPath, '').substring(1);

  const stats = await stat(absolutePath);

  if (verbose) {
    console.log(`Processing: ${absolutePath}`);
  }

  if (stats.isFile()) {
    archive.file(absolutePath, { name: relativePath });
  } else if (stats.isDirectory()) {
    const items = await readdir(absolutePath);
    for (const item of items) {
      const itemPath = path.join(absolutePath, item);
      archive.file(itemPath, { name: path.join(relativePath, item) });
    }
  }
};

export const createArchive = async (
  projectName: string,
  output: string,
  concurrency: number,
  verbose: boolean,
): Promise<void> => {
  const outputStream = createWriteStream(output);
  const archive = archiver('zip', {
    zlib: { level: 9 },
  });

  const archivePromise = new Promise<void>((resolve, reject) => {
    outputStream.on('close', resolve);
    archive.on('warning', (error) => console.warn(`Archive warning: ${error.message}`));
    archive.on('error', reject);
    archive.pipe(outputStream);
  });

  const runningPromises: Set<Promise<void>> = new Set();
  const allPaths: string[] = [];

  const command = 'pnpm';
  const args = ['ls', '--filter', projectName, '--depth', 'Infinity', '--parseable'];
  const child = spawn(command, args);

  let firstLine = true;

  child.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      if (firstLine) {
        firstLine = false;
      } else {
        allPaths.push(line.trim());
      }
    }
  });

  child.stdout.on('end', async () => {
    for (const itemPath of allPaths) {
      if (runningPromises.size >= concurrency) {
        await Promise.race(runningPromises);
      }

      const promise = addToArchive(itemPath, archive, verbose).catch((error) =>
        console.error(
          `Error adding to archive: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );

      runningPromises.add(promise);
      promise.then(() => runningPromises.delete(promise));
    }

    await Promise.all(runningPromises);
    archive.finalize();
    await archivePromise;
  });
};

const projectExists = async (projectName: string): Promise<boolean> => {
  const output = await runPnpmCommand(['list', '--filter', projectName]);
  const regex = new RegExp(`^${projectName}@`, 'm');
  return regex.test(output);
};

yargs(hideBin(process.argv))
  .scriptName('pnpack')
  .usage('Usage: $0 <command> [options]')
  .command(
    'zip',
    'Creates a ZIP archive of a package and all its dependencies, optimized for serverless deployments and containerization.',
    (yargs) =>
      yargs
        .option('project', {
          alias: 'p',
          type: 'string',
          describe: 'Defines the name of the project to pack.',
          demandOption: true,
        })
        .option('output', {
          alias: 'o',
          type: 'string',
          describe:
            'Specifies the path where the zipped archive will be saved. Ensure the path ends with a .zip extension.',
          demandOption: true,
        })
        .option('concurrency', {
          alias: 'c',
          type: 'number',
          default: os.cpus().length,
          describe:
            'Defines the number of concurrent operations PnPack should use when archiving. By default, it uses the number of available CPU cores.',
        })
        .option('verbose', {
          alias: 'v',
          type: 'boolean',
          default: false,
          describe:
            'Enables detailed logging during the archiving process, providing insights into each step.',
        }),
    async ({ project, output, concurrency, verbose }) => {
      console.log(`Checking if project "${project}" exists...`);
      const exists = await projectExists(project);
      if (!exists) {
        console.error(`Error: Project "${project}" does not exist in the pnpm workspace.`);
        process.exit(1);
      }

      console.log(`Checking output file "${output}"...`);
      if (!output.endsWith('.zip')) {
        console.error(`Error: Output file "${output}" should have a .zip extension.`);
        process.exit(1);
      }

      const outputDir = path.dirname(output);
      if (
        !(await access(outputDir)
          .then(() => true)
          .catch(() => false))
      ) {
        throw new Error(`Output directory "${outputDir}" does not exist.`);
      }

      await createArchive(project, output, concurrency, verbose);
    },
  )
  .help('h')
  .alias('h', 'help')
  .example(
    '$0 zip -o ./output/archive.zip -p my-package',
    'Archive the "my-package" directory and its dependencies into "archive.zip" in the "output" directory.',
  ).argv;
