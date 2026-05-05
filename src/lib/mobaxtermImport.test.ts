import { describe, expect, it } from 'vitest'

import { parseMobaXtermSessionsFile } from './mobaxtermImport'

describe('parseMobaXtermSessionsFile', () => {
  it('imports supported MobaXterm session kinds and folders', () => {
    const result = parseMobaXtermSessionsFile(`
[Bookmarks]
SubRep=Servers\\Linux
ssh-root=#109#0%10.0.0.10%2222%root%%#MobaFont
telnet-router=#98#0%10.0.0.1%23%admin%%#MobaFont
sftp-files=#140#0%files.example.com%22%deploy%%#MobaFont
ftp-archive=#130#0%ftp.example.com%21%archive%%#MobaFont
serial-console=#131#0%0%115200%3%0%0%1%/dev/tty.usbserial#MobaFont
vnc-console=#112#0%10.0.0.20%5900%%#MobaFont
`)

    expect(result.folders.map((folder) => folder.path)).toEqual(['Servers', 'Servers/Linux'])
    expect(result.sessions.map((session) => session.kind)).toEqual(['ssh', 'telnet', 'sftp', 'ftp', 'serial'])
    expect(result.sessions.map((session) => session.folderPath)).toEqual([
      'Servers/Linux',
      'Servers/Linux',
      'Servers/Linux',
      'Servers/Linux',
      'Servers/Linux',
    ])
    expect(result.sessions[0]).toMatchObject({
      name: 'ssh-root',
      host: '10.0.0.10',
      port: 2222,
      username: 'root',
    })
    expect(result.sessions[4]).toMatchObject({
      name: 'serial-console',
      serialPort: '/dev/tty.usbserial',
      baudRate: 115200,
      dataBits: 8,
    })
    expect(result.skipped).toEqual([
      {
        name: 'vnc-console',
        reason: 'Unsupported or incomplete MobaXterm session type (112)',
      },
    ])
  })
})
