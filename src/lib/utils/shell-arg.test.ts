import { describe, expect, it } from 'vitest';
import { classifyLaunchArg } from './shell-arg';

describe('classifyLaunchArg', () => {
  it("This PC's CLSID is ours", () => {
    expect(classifyLaunchArg('::{20D04FE0-3AEA-1069-A2D8-08002B30309D}')).toBe('this-pc');
  });

  it("the Recycle Bin's CLSID is ours, in any case", () => {
    expect(classifyLaunchArg('::{645FF040-5081-101B-9F08-00AA002F954E}')).toBe('recycle-bin');
    expect(classifyLaunchArg(' ::{645ff040-5081-101b-9f08-00aa002f954e} ')).toBe('recycle-bin');
  });

  it('any other shell folder goes to Explorer', () => {
    expect(classifyLaunchArg('::{26EE0668-A00A-44D7-9371-BEB064C98683}')).toBe('explorer');
    expect(classifyLaunchArg('shell:AppsFolder')).toBe('explorer');
    expect(classifyLaunchArg('Shell:Downloads')).toBe('explorer');
  });

  it('a plain path is a path', () => {
    expect(classifyLaunchArg('C:\\Users\\alex')).toBe('path');
    expect(classifyLaunchArg('Ubuntu:/home/alex')).toBe('path');
  });
});
