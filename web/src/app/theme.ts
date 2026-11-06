import type { ThemeConfig } from 'antd';

export const appTheme: ThemeConfig = {
  token: {
    colorPrimary: '#1677ff',
    borderRadius: 4,
    borderRadiusLG: 6,
    borderRadiusSM: 4,
    colorBgLayout: '#f5f7fa',
    colorBorderSecondary: '#e5e7eb',
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Inter", "PingFang SC", "Microsoft YaHei", sans-serif',
  },
  components: {
    Card: {
      headerFontSize: 14,
      borderRadiusLG: 6,
    },
    Button: {
      borderRadius: 4,
      borderRadiusLG: 4,
      borderRadiusSM: 4,
    },
    Input: {
      borderRadius: 4,
    },
    Select: {
      borderRadius: 4,
    },
    Table: {
      headerBg: '#f8fafc',
      headerColor: '#475569',
      borderRadius: 4,
    },
    Menu: {
      itemBorderRadius: 4,
      itemMarginInline: 8,
    },
  },
};
