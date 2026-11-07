-- 删掉 SelectBench 的运行表；仍有对象依赖它时迁移失败，不会连带删除。不带 CASCADE。
DROP TABLE IF EXISTS selectbench_runs;
