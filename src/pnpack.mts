import { dirname } from 'node:path';
import { cpus } from 'node:os';
import { access, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';

const runPnpmCommand = async (args: string[]): Promise<string> => {
  return new Promise((resolve, reject) => {
    const command = 'pnpm';
    const child = spawn(command, args, { shell: true });
    let output = '';

    child.stdout.on('data', (data) => {
      output += data.toString();
    });

    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`Command "${command} ${args.join(' ')}" exited with code ${code}.`));
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

const createLSFile = async (projectName: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    const command = 'pnpm';
    const args = ['ls', '--filter', projectName, '--depth', 'Infinity', '--parseable'];
    const child = spawn(command, args, { shell: true });
    const fileStream = createWriteStream('listfile.txt');
    const uniqueLines = new Set<string>();

    child.stdout.on('data', (chunk) => {
      const lines: string[] = chunk.toString().split('\n');
      for (const line of lines) {
        uniqueLines.add(line);
      }
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Command "${command} ${args.join(' ')}" exited with code ${code}.`));
      } else {
        fileStream.write([...uniqueLines].join('\n'), () => {
          fileStream.end();
          resolve(fileStream.path as string);
        });
      }
    });

    child.on('error', (error) => {
      reject(error);
    });
  });
};

export const createArchive = async (
  projectName: string,
  output: string,
  concurrency: number,
  verbose: boolean,
): Promise<void> => {
  const lsFilePath = await createLSFile(projectName);
  const command = '7z';
  const args = [
    'a',
    'output',
    '@listfile.txt',
    '-aos',
    '-spf',
    '-spe',
    `-mmt${concurrency}`,
    `-mx9`,
  ];
  const child = spawn(command, args, { shell: true });
  child.on('close', async (code) => {
    try {
      await unlink(lsFilePath);
    } catch (error) {
      console.warn(
        `Failed to remove temporary file "${lsFilePath}". ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    if (code !== 0) {
      throw new Error(`Command "${command} ${args.join(' ')}" exited with code ${code}.`);
    }

    const rootPath = await getRootPath();
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
    '7zip',
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
          default: cpus().length,
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
      try {
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

        const outputDir = dirname(output);
        if (
          !(await access(outputDir)
            .then(() => true)
            .catch(() => false))
        ) {
          throw new Error(`Output directory "${outputDir}" does not exist.`);
        }

        await createArchive(project, output, concurrency, verbose);
      } catch (error) {
        console.error(
          `An error occurred: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    },
  )
  .help('h')
  .alias('h', 'help')
  .example(
    '$0 zip -o ./output/archive.zip -p my-package',
    'Archive the "my-package" directory and its dependencies into "archive.zip" in the "output" directory.',
  ).argv;
